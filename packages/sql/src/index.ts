import {
  type AggregateOp,
  type AggregateSpec,
  type Expr,
  LaQLError,
  type OrderByTerm,
  type PathQueryInit,
} from "@laql/core";

export interface SqlQueryAst extends PathQueryInit {
  groupBy?: string[];
  aggregates?: AggregateSpec;
  having?: Expr;
}

type TokenKind = "identifier" | "number" | "string" | "operator" | "punct" | "keyword" | "eof";

interface Token {
  kind: TokenKind;
  value: string;
}

const KEYWORDS = new Set([
  "and",
  "as",
  "between",
  "by",
  "false",
  "from",
  "group",
  "having",
  "ilike",
  "in",
  "is",
  "like",
  "limit",
  "not",
  "null",
  "offset",
  "or",
  "order",
  "asc",
  "desc",
  "first",
  "last",
  "nulls",
  "select",
  "true",
  "where",
]);

const CLAUSE_KEYWORDS = new Set(["select", "where", "group", "having", "order", "limit", "offset"]);

export function parseSql(sql: string): SqlQueryAst {
  const parser = new Parser(tokenize(sql));
  return parser.parseQuery();
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parseQuery(): SqlQueryAst {
    this.expectKeyword("from");
    const source = this.expectIdentifierLike("source");
    const query: SqlQueryAst = { source };

    while (!this.peek("eof")) {
      if (this.matchKeyword("select")) {
        const selected = this.parseSelectList();
        if (selected.select.length > 0) query.select = selected.select;
        if (Object.keys(selected.aggregates).length > 0) query.aggregates = selected.aggregates;
      } else if (this.matchKeyword("where")) {
        query.where = this.parseExprUntil(CLAUSE_KEYWORDS);
      } else if (this.matchKeyword("group")) {
        this.expectKeyword("by");
        query.groupBy = this.parseIdentifierList();
      } else if (this.matchKeyword("having")) {
        query.having = this.parseExprUntil(CLAUSE_KEYWORDS);
      } else if (this.matchKeyword("order")) {
        this.expectKeyword("by");
        query.orderBy = this.parseOrderBy();
      } else if (this.matchKeyword("limit")) {
        query.limit = this.expectNonNegativeInteger("limit");
      } else if (this.matchKeyword("offset")) {
        query.offset = this.expectNonNegativeInteger("offset");
      } else {
        throwParse(`Unexpected token ${this.current().value}`);
      }
    }

    return query;
  }

  private parseSelectList(): { select: string[]; aggregates: AggregateSpec } {
    const select: string[] = [];
    const aggregates: AggregateSpec = {};
    while (!this.atClauseBoundary()) {
      const first = this.expectIdentifierLike("select expression");
      if (this.matchPunct("(")) {
        const args = this.parseCallArgs();
        const alias = this.matchKeyword("as")
          ? this.expectIdentifierLike("aggregate alias")
          : first;
        aggregates[alias] = { op: aggregateOp(first), ...(args[0] ? { column: args[0] } : {}) };
      } else {
        const alias = this.matchKeyword("as") ? this.expectIdentifierLike("select alias") : first;
        select.push(alias === first ? first : `${first} as ${alias}`);
      }
      if (!this.matchPunct(",")) break;
    }
    return { select, aggregates };
  }

  private parseCallArgs(): string[] {
    if (this.matchPunct(")")) return [];
    const args: string[] = [];
    do {
      args.push(this.expectIdentifierLike("function argument"));
    } while (this.matchPunct(","));
    this.expectPunct(")");
    return args;
  }

  private parseIdentifierList(): string[] {
    const columns: string[] = [];
    do {
      columns.push(this.expectIdentifierLike("column"));
    } while (this.matchPunct(","));
    return columns;
  }

  private parseOrderBy(): OrderByTerm[] {
    const terms: OrderByTerm[] = [];
    do {
      const term: OrderByTerm = { column: this.expectIdentifierLike("order column") };
      if (this.matchKeyword("asc")) term.direction = "asc";
      else if (this.matchKeyword("desc")) term.direction = "desc";
      if (this.matchKeyword("nulls")) {
        if (this.matchKeyword("first")) term.nulls = "first";
        else if (this.matchKeyword("last")) term.nulls = "last";
        else throwParse("Expected FIRST or LAST after NULLS");
      }
      terms.push(term);
    } while (this.matchPunct(","));
    return terms;
  }

  private parseExprUntil(boundaries: Set<string>): Expr {
    const stop = () =>
      this.peek("eof") ||
      (this.current().kind === "keyword" && boundaries.has(this.current().value));
    const expr = this.parseOr(stop);
    if (!stop()) throwParse(`Unexpected token ${this.current().value}`);
    return expr;
  }

  private parseOr(stop: () => boolean): Expr {
    const operands = [this.parseAnd(stop)];
    while (!stop() && this.matchKeyword("or")) operands.push(this.parseAnd(stop));
    return operands.length === 1
      ? (operands[0] ?? literal(null))
      : { kind: "logical", op: "or", operands };
  }

  private parseAnd(stop: () => boolean): Expr {
    const operands = [this.parseNot(stop)];
    while (!stop() && this.matchKeyword("and")) operands.push(this.parseNot(stop));
    return operands.length === 1
      ? (operands[0] ?? literal(null))
      : { kind: "logical", op: "and", operands };
  }

  private parseNot(stop: () => boolean): Expr {
    if (this.matchKeyword("not")) return { kind: "not", operand: this.parseNot(stop) };
    return this.parsePredicate(stop);
  }

  private parsePredicate(stop: () => boolean): Expr {
    const left = this.parsePrimary(stop);
    if (this.matchKeyword("between")) {
      const low = this.parsePrimary(stop);
      this.expectKeyword("and");
      return { kind: "between", target: left, low, high: this.parsePrimary(stop) };
    }
    if (this.matchKeyword("not")) {
      if (this.matchKeyword("in")) return this.parseIn(left, true, stop);
      if (this.matchKeyword("like")) return this.parseLike(left, true, false, stop);
      throwParse("Expected IN or LIKE after NOT");
    }
    if (this.matchKeyword("in")) return this.parseIn(left, false, stop);
    if (this.matchKeyword("like")) return this.parseLike(left, false, false, stop);
    if (this.matchKeyword("ilike")) return this.parseLike(left, false, true, stop);
    if (this.matchKeyword("is")) {
      const negated = this.matchKeyword("not");
      this.expectKeyword("null");
      return { kind: "null-check", negated, target: left };
    }
    if (this.current().kind === "operator") {
      const op = compareOp(this.advance().value);
      return { kind: "compare", op, left, right: this.parsePrimary(stop) };
    }
    return left;
  }

  private parseIn(left: Expr, negated: boolean, stop: () => boolean): Expr {
    this.expectPunct("(");
    const values: Expr[] = [];
    do {
      values.push(this.parsePrimary(stop));
    } while (this.matchPunct(","));
    this.expectPunct(")");
    return { kind: "in", negated, target: left, values };
  }

  private parseLike(
    left: Expr,
    negated: boolean,
    caseInsensitive: boolean,
    stop: () => boolean,
  ): Expr {
    const pattern = this.parsePrimary(stop);
    if (pattern.kind !== "literal" || typeof pattern.value !== "string") {
      throwParse("LIKE pattern must be a string literal");
    }
    const expr: Expr = { kind: "like", caseInsensitive, target: left, pattern: pattern.value };
    return negated ? { kind: "not", operand: expr } : expr;
  }

  private parsePrimary(stop: () => boolean): Expr {
    if (stop()) throwParse("Expected expression");
    if (this.matchPunct("(")) {
      const expr = this.parseOr(() => this.peekPunct(")"));
      this.expectPunct(")");
      return expr;
    }
    const token = this.advance();
    if (token.kind === "identifier" || token.kind === "keyword") {
      if (token.value === "true") return literal(true);
      if (token.value === "false") return literal(false);
      if (token.value === "null") return literal(null);
      if (this.matchPunct("(")) {
        const args: Expr[] = [];
        if (!this.matchPunct(")")) {
          do {
            args.push(this.parseOr(() => this.peekPunct(",") || this.peekPunct(")")));
          } while (this.matchPunct(","));
          this.expectPunct(")");
        }
        return { kind: "call", fn: token.value, args };
      }
      return { kind: "column", name: token.value };
    }
    if (token.kind === "string") return literal(token.value);
    if (token.kind === "number") return literal(Number(token.value));
    throwParse(`Expected expression, received ${token.value}`);
  }

  private expectIdentifierLike(label: string): string {
    const token = this.advance();
    if (token.kind !== "identifier" && token.kind !== "keyword" && token.kind !== "string") {
      throwParse(`Expected ${label}`);
    }
    return token.value;
  }

  private expectNonNegativeInteger(label: string): number {
    const token = this.advance();
    if (
      token.kind !== "number" ||
      !Number.isInteger(Number(token.value)) ||
      Number(token.value) < 0
    ) {
      throwParse(`${label} must be a non-negative integer`);
    }
    return Number(token.value);
  }

  private atClauseBoundary(): boolean {
    return (
      this.peek("eof") ||
      (this.current().kind === "keyword" && CLAUSE_KEYWORDS.has(this.current().value))
    );
  }

  private expectKeyword(value: string): void {
    if (!this.matchKeyword(value)) throwParse(`Expected ${value.toUpperCase()}`);
  }

  private matchKeyword(value: string): boolean {
    if (this.current().kind === "keyword" && this.current().value === value) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private expectPunct(value: string): void {
    if (!this.matchPunct(value)) throwParse(`Expected ${value}`);
  }

  private matchPunct(value: string): boolean {
    if (this.peekPunct(value)) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private peekPunct(value: string): boolean {
    return this.current().kind === "punct" && this.current().value === value;
  }

  private peek(kind: TokenKind): boolean {
    return this.current().kind === kind;
  }

  private current(): Token {
    return this.tokens[this.index] ?? { kind: "eof", value: "" };
  }

  private advance(): Token {
    const token = this.current();
    this.index += 1;
    return token;
  }
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index] ?? "";
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === "'") {
      const end = input.indexOf("'", index + 1);
      if (end === -1) throwParse("Unterminated string literal");
      tokens.push({ kind: "string", value: input.slice(index + 1, end) });
      index = end + 1;
      continue;
    }
    if (/[(),]/u.test(char)) {
      tokens.push({ kind: "punct", value: char });
      index += 1;
      continue;
    }
    const two = input.slice(index, index + 2);
    if (["<=", ">=", "<>", "!="].includes(two)) {
      tokens.push({ kind: "operator", value: two });
      index += 2;
      continue;
    }
    if (/[=<>]/u.test(char)) {
      tokens.push({ kind: "operator", value: char });
      index += 1;
      continue;
    }
    const number = /^-?[0-9]+(?:\.[0-9]+)?/u.exec(input.slice(index));
    if (number) {
      tokens.push({ kind: "number", value: number[0] });
      index += number[0].length;
      continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_.*:/=-]*/u.exec(input.slice(index));
    if (identifier) {
      const value = identifier[0].toLowerCase();
      tokens.push({ kind: KEYWORDS.has(value) ? "keyword" : "identifier", value });
      index += identifier[0].length;
      continue;
    }
    throwParse(`Unexpected character ${char}`);
  }
  tokens.push({ kind: "eof", value: "" });
  return tokens;
}

function compareOp(op: string): "eq" | "ne" | "lt" | "lte" | "gt" | "gte" {
  switch (op) {
    case "=":
      return "eq";
    case "!=":
    case "<>":
      return "ne";
    case "<":
      return "lt";
    case "<=":
      return "lte";
    case ">":
      return "gt";
    case ">=":
      return "gte";
    default:
      throwParse(`Unsupported comparison operator ${op}`);
  }
}

function aggregateOp(op: string): AggregateOp {
  switch (op) {
    case "count":
    case "sum":
    case "avg":
    case "min":
    case "max":
    case "count_distinct":
    case "first":
    case "last":
    case "any":
      return op;
    default:
      throwParse(`Unsupported aggregate ${op}`);
  }
}

function literal(value: string | number | boolean | null): Expr {
  return { kind: "literal", value };
}

function throwParse(message: string): never {
  throw new LaQLError("LAQL_PARSE_ERROR", message);
}
