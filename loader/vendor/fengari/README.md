# Fengari

[Fengari](https://fengari.io/) 0.1.4 (`fengari-web` from npm,
`dist/fengari-web.js`), a Lua 5.3 VM in JavaScript, MIT licensed (see
`LICENSE`). The editor runs NodeCore mods in it.

One change from the published file: the web build's `luaconf` object is
`{LUA_COMPAT_FLOATSTRING: true}` instead of `{}`, so a float with no
fraction prints as `2`, not `2.0`, the way LuaJIT (which Luanti runs mods
on) prints it. Mods build node names by concatenating numbers, so this
matters.
