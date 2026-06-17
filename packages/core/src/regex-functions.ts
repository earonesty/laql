import { LakeqlError } from "./errors.js";

export interface RegexOptions {
  global: boolean;
  flags: string;
  literal: boolean;
}

export function regexpMatchesValue(value: string, pattern: string, options = ""): boolean {
  const regexOptions = parseRegexOptions("regexp_matches", options, { allowGlobal: false });
  return compileRegex("regexp_matches", pattern, regexOptions).test(value);
}

export function regexpReplaceValue(
  value: string,
  pattern: string,
  replacement: string,
  options = "",
): string {
  const regexOptions = parseRegexOptions("regexp_replace", options, { allowGlobal: true });
  const regex = compileRegex("regexp_replace", pattern, regexOptions);
  return value.replace(regex, duckdbReplacementToJs(replacement));
}

function compileRegex(name: string, pattern: string, options: RegexOptions): RegExp {
  const source = options.literal ? escapeRegexPattern(pattern) : pattern;
  try {
    return new RegExp(source, options.flags);
  } catch (cause) {
    throw new LakeqlError("LAKEQL_TYPE_ERROR", `${name}() received an invalid regular expression`, {
      pattern,
      cause,
    });
  }
}

function parseRegexOptions(
  name: string,
  options: string,
  input: { allowGlobal: boolean },
): RegexOptions {
  let caseInsensitive = false;
  let multiline = false;
  let dotAll = false;
  let literal = false;
  let global = false;
  for (const option of options) {
    switch (option) {
      case "c":
        caseInsensitive = false;
        break;
      case "i":
        caseInsensitive = true;
        break;
      case "g":
        if (!input.allowGlobal) {
          throw new LakeqlError(
            "LAKEQL_TYPE_ERROR",
            "g regex option is only valid for regexp_replace()",
          );
        }
        global = true;
        break;
      case "l":
        literal = true;
        break;
      case "m":
      case "n":
      case "p":
        multiline = true;
        break;
      case "s":
        dotAll = true;
        break;
      default:
        throw new LakeqlError(
          "LAKEQL_TYPE_ERROR",
          `${name}() received an unsupported regex option`,
          {
            option,
          },
        );
    }
  }
  return {
    global,
    literal,
    flags: `${caseInsensitive ? "i" : ""}${multiline ? "m" : ""}${dotAll ? "s" : ""}${global ? "g" : ""}`,
  };
}

function duckdbReplacementToJs(replacement: string): string {
  return replacement.replace(/\\([1-9])/g, "$$$1");
}

function escapeRegexPattern(pattern: string): string {
  return pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
