---
"@laql/http": patch
---

Bind the default global `fetch` to `globalThis` in `httpStore`. Browsers throw
`TypeError: Illegal invocation` when `fetch` is invoked as a method with a
non-global `this`; Node and workerd tolerated it, so this only surfaced when
running LaQL directly in a browser (e.g. the playground). A caller-supplied
`fetch` is still used as-is.
