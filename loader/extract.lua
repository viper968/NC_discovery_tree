-- Loads Luanti mods (NodeCore's own plus any added ones) under a permissive
-- stand-in for the engine API and reads back what they register: items,
-- crafting recipes (core.register_craft and nc.register_craft) and
-- NodeCore hints.
--
-- The engine stand-in is adapted from nodecore_light_logic_sim's
-- scripts/nodecore/mock.lua; the Lua 5.1 / LuaJIT compatibility block from
-- that repo's src/mods/prelude.js. JavaScript supplies, before this runs:
--   __readfile(path) -> string | nil
--   __listdir(path, dirs) -> {names}
--   MOD_LIST  = {"modname", ...} in load order
--   MOD_PATHS = {modname = "/mods/modname"}
--   PROBE_ABMS = true to try every ABM and item-stack ABM on what it applies
--                to, or a set {modname = true} to try only what those mods add

---------------------------------------------------------------------------
-- Lua 5.1 / LuaJIT compatibility (mods are written for LuaJIT)

unpack = unpack or table.unpack
table.maxn = table.maxn or function(t)
  local m = 0
  for k in pairs(t) do if type(k) == "number" and k > m then m = k end end
  return m
end
table.getn = table.getn or function(t) return #t end
math.pow = math.pow or function(a, b) return a ^ b end
math.mod = math.mod or math.fmod
math.log10 = math.log10 or function(x) return math.log(x, 10) end
string.gfind = string.gfind or string.gmatch

local function findenv(f)
  local i = 1
  while true do
    local name = debug.getupvalue(f, i)
    if name == "_ENV" then return i end
    if not name then return nil end
    i = i + 1
  end
end
function setfenv(f, env)
  if type(f) == "number" then f = debug.getinfo(f + 1, "f").func end
  local i = findenv(f)
  if i then debug.upvaluejoin(f, i, function() return env end, 1) end
  return f
end
function getfenv(f)
  if f == nil or f == 0 then return _G end
  if type(f) == "number" then f = debug.getinfo(f + 1, "f").func end
  local i = findenv(f)
  if not i then return _G end
  local _, env = debug.getupvalue(f, i)
  return env
end

bit = {
  band = function(a, ...) a = math.floor(a) for _, b in ipairs({...}) do a = a & math.floor(b) end return a end,
  bor = function(a, ...) a = math.floor(a) for _, b in ipairs({...}) do a = a | math.floor(b) end return a end,
  bxor = function(a, ...) a = math.floor(a) for _, b in ipairs({...}) do a = a ~ math.floor(b) end return a end,
  bnot = function(a) return ~math.floor(a) end,
  lshift = function(a, n) return math.floor(a) << n end,
  rshift = function(a, n) return (math.floor(a) & 0xffffffff) >> n end,
  arshift = function(a, n) return math.floor(a) >> n end,
  tobit = function(a) return math.floor(a) end,
}

-- Fengari's require could fetch and run JavaScript from the page's site;
-- a mod from the internet must not reach that (nor bytecode).
require = nil
package = nil
module = nil
fengari = nil
do
  local rawload = load
  load = function(chunk, name, mode, ...)
    if select("#", ...) > 0 then return rawload(chunk, name, "t", ...) end
    return rawload(chunk, name, "t")
  end
  loadstring = load
end

-- Deterministic dice: registrations must not depend on luck.
do
  local seed = 12345
  math.random = function(m, n)
    seed = (seed * 1103515245 + 12345) % 2147483648
    local r = seed / 2147483648
    if m == nil then return r end
    if n == nil then m, n = 1, m end
    return m + math.floor(r * (n - m + 1))
  end
  math.randomseed = function() end
end

---------------------------------------------------------------------------
-- Files: mods read their own code (and occasionally data) from the
-- virtual tree JavaScript holds. Nothing is ever written.

local readfile, listdir = __readfile, __listdir
__readfile, __listdir = nil, nil

local function normpath(p)
  local out = {}
  for part in tostring(p):gmatch("[^/]+") do
    if part == ".." then out[#out] = nil
    elseif part ~= "." then out[#out + 1] = part end
  end
  return "/" .. table.concat(out, "/")
end

function loadfile(path)
  path = normpath(path)
  local src = readfile(path)
  if not src then return nil, "cannot open " .. path end
  return load(src, "@" .. path)
end
function dofile(path)
  local f, err = loadfile(path)
  if not f then error(err, 2) end
  return f()
end

local sink = setmetatable({}, {__index = function() return function() return true end end})
io = io or {}
io.open = function(path, mode)
  if mode and mode:find("[wa+]") then return sink end
  local src = readfile(normpath(path))
  if not src then return nil, "cannot open " .. tostring(path) end
  local pos = 1
  local fh = {}
  function fh:read(fmt)
    fmt = fmt or "*l"
    if pos > #src then return nil end
    if fmt == "*a" or fmt == "*all" or fmt == "a" then
      local s = src:sub(pos) pos = #src + 1 return s
    end
    local e = src:find("\n", pos, true) or (#src + 1)
    local s = src:sub(pos, e - 1) pos = e + 1 return s
  end
  function fh:lines() return function() return fh:read("*l") end end
  function fh:close() return true end
  function fh:seek() return 0 end
  function fh:write() return fh end
  return fh
end
io.lines = function(path) local f = io.open(path) return f and f:lines() or function() end end
os.remove = function() return nil, "no files here" end
os.rename = function() return nil, "no files here" end
os.getenv = function() return nil end
os.exit = function() error("os.exit is not allowed") end
os.execute = nil

---------------------------------------------------------------------------
-- The engine stand-in (after nodecore_light_logic_sim's mock.lua)

local anyfn
local anymeta = {}
anymeta.__index = function() return anyfn end
anymeta.__call = function() return setmetatable({}, anymeta) end
anymeta.__concat = function(a, b) return tostring(a) .. tostring(b) end
anymeta.__tostring = function() return "" end
anyfn = setmetatable({}, anymeta)

vector = {}
local vmt = {}
function vector.new(x, y, z)
  if type(x) == "table" then return setmetatable({x = x.x, y = x.y, z = x.z}, vmt) end
  return setmetatable({x = x or 0, y = y or 0, z = z or 0}, vmt)
end
function vector.add(a, b) if type(b) == "number" then return vector.new(a.x+b, a.y+b, a.z+b) end return vector.new(a.x+b.x, a.y+b.y, a.z+b.z) end
function vector.subtract(a, b) if type(b) == "number" then return vector.new(a.x-b, a.y-b, a.z-b) end return vector.new(a.x-b.x, a.y-b.y, a.z-b.z) end
function vector.multiply(a, s) return vector.new(a.x*s, a.y*s, a.z*s) end
function vector.divide(a, s) return vector.new(a.x/s, a.y/s, a.z/s) end
function vector.equals(a, b) return a.x == b.x and a.y == b.y and a.z == b.z end
function vector.length(a) return math.sqrt(a.x*a.x + a.y*a.y + a.z*a.z) end
function vector.normalize(a) local l = vector.length(a) if l == 0 then return vector.new(0,0,0) end return vector.divide(a, l) end
function vector.round(a) return vector.new(math.floor(a.x+0.5), math.floor(a.y+0.5), math.floor(a.z+0.5)) end
function vector.dot(a, b) return a.x*b.x + a.y*b.y + a.z*b.z end
function vector.cross(a, b) return vector.new(a.y*b.z - a.z*b.y, a.z*b.x - a.x*b.z, a.x*b.y - a.y*b.x) end
function vector.distance(a, b) return vector.length(vector.subtract(a, b)) end
function vector.copy(a) return vector.new(a) end
function vector.offset(a, x, y, z) return vector.new(a.x+x, a.y+y, a.z+z) end
function vector.zero() return vector.new(0,0,0) end
function vector.apply(a, f) return vector.new(f(a.x), f(a.y), f(a.z)) end
function vector.floor(a) return vector.new(math.floor(a.x), math.floor(a.y), math.floor(a.z)) end
function vector.sort(a, b) return vector.new(math.min(a.x,b.x), math.min(a.y,b.y), math.min(a.z,b.z)), vector.new(math.max(a.x,b.x), math.max(a.y,b.y), math.max(a.z,b.z)) end
function vector.to_string(a) return "(" .. a.x .. ", " .. a.y .. ", " .. a.z .. ")" end
vmt.__index = vector
vmt.__add = vector.add
vmt.__sub = vector.subtract
vmt.__eq = vector.equals
vmt.__unm = function(a) return vector.new(-a.x, -a.y, -a.z) end
vmt.__mul = function(a, b) if type(a) == "number" then return vector.multiply(b, a) end return vector.multiply(a, b) end

function table.copy(t, seen)
  if type(t) ~= "table" then return t end
  seen = seen or {}
  if seen[t] then return seen[t] end
  local n = {}
  seen[t] = n
  for k, v in pairs(t) do n[table.copy(k, seen)] = table.copy(v, seen) end
  return setmetatable(n, getmetatable(t))
end
function table.shuffle(t) return t end
function table.indexof(t, v) for i, x in ipairs(t) do if x == v then return i end end return -1 end
function table.insert_all(t, o) for _, v in ipairs(o) do t[#t+1] = v end return t end
function table.key_value_swap(t) local n = {} for k, v in pairs(t) do n[v] = k end return n end
function string.split(str, delim, include_empty, max_splits, sep_is_pattern)
  delim = delim or ","
  max_splits = max_splits or -2
  local items = {}
  local pos, len = 1, #str
  local plain = not sep_is_pattern
  max_splits = max_splits + 1
  repeat
    local np, npe = string.find(str, delim, pos, plain)
    np, npe = (np or (len + 1)), (npe or (len + 1))
    if (not np) or (max_splits == 1) then np = len + 1 npe = np end
    local s = string.sub(str, pos, np - 1)
    if include_empty or (s ~= "") then
      max_splits = max_splits - 1
      items[#items + 1] = s
    end
    pos = npe + 1
  until (max_splits == 0) or (pos > (len + 1))
  return items
end
function string.trim(s) return (s:gsub("^%s*(.-)%s*$", "%1")) end
function dump(x) return tostring(x) end

-- A working ItemStack: name, count, wear and metadata, so code that moves
-- stacks about (and the item-stack ABMs probed below) behaves.
local function newmeta(store)
  store = store or {}
  return setmetatable({
    get_string = function(_, f) return store[f] ~= nil and tostring(store[f]) or "" end,
    set_string = function(_, f, v) if v == "" then store[f] = nil else store[f] = v end end,
    get_int = function(_, f) return math.floor(tonumber(store[f]) or 0) end,
    set_int = function(_, f, v) store[f] = v end,
    get_float = function(_, f) return tonumber(store[f]) or 0 end,
    set_float = function(_, f, v) store[f] = v end,
    contains = function(_, f) return store[f] ~= nil end,
    to_table = function() return {fields = table.copy(store), inventory = {}} end,
    from_table = function(_, t) for k in pairs(store) do store[k] = nil end
      for k, v in pairs(type(t) == "table" and t.fields or {}) do store[k] = v end return true end,
    equals = function(_, o) return o == store end,
    mark_as_private = function() end,
    get_keys = function() local k = {} for f in pairs(store) do k[#k + 1] = f end return k end,
  }, anymeta), store
end
local stackmeta = {}
stackmeta.__index = stackmeta
local function stackdef(st) return core.registered_items[st.name] or {} end
function stackmeta:get_name() return self.name end
function stackmeta:set_name(n) self.name = n or "" if self.name == "" then self.count = 0 end return true end
function stackmeta:get_count() return self.name == "" and 0 or self.count end
function stackmeta:set_count(c) self.count = math.max(0, math.floor(c or 0)) if self.count == 0 then self.name = "" end return true end
function stackmeta:get_wear() return self.wear end
function stackmeta:set_wear(w) self.wear = w or 0 return true end
function stackmeta:add_wear(w) self.wear = self.wear + (w or 0) if self.wear >= 65536 then self:clear() end return true end
function stackmeta:is_empty() return self.name == "" or self.count <= 0 end
function stackmeta:clear() self.name, self.count, self.wear = "", 0, 0 return true end
function stackmeta:get_meta() return self.meta end
function stackmeta:get_metadata() return "" end
function stackmeta:get_definition() return stackdef(self) end
function stackmeta:get_stack_max() return tonumber(stackdef(self).stack_max) or 99 end
function stackmeta:get_free_space() return self:get_stack_max() - self:get_count() end
function stackmeta:is_known() return core.registered_items[self.name] ~= nil end
function stackmeta:get_tool_capabilities()
  return stackdef(self).tool_capabilities or (core.registered_items[""] or {}).tool_capabilities or {groupcaps = {}}
end
function stackmeta:get_description() return stackdef(self).description or self.name end
function stackmeta:get_short_description() return self:get_description() end
function stackmeta:to_string()
  if self:is_empty() then return "" end
  return self.name .. (self.count ~= 1 and (" " .. self.count) or "") .. (self.wear ~= 0 and (" " .. self.wear) or "")
end
function stackmeta:to_table() if self:is_empty() then return nil end return {name = self.name, count = self.count, wear = self.wear} end
function stackmeta:peek_item(n) local t = ItemStack(self) t:set_count(math.min(n or 1, self:get_count())) return t end
function stackmeta:take_item(n)
  n = math.min(n or 1, self:get_count())
  local t = ItemStack(self)
  t:set_count(n)
  self:set_count(self:get_count() - n)
  return t
end
function stackmeta:item_fits(o)
  o = ItemStack(o)
  return self:is_empty() or (o.name == self.name and self:get_free_space() >= o:get_count())
end
function stackmeta:add_item(o)
  o = ItemStack(o)
  if o:is_empty() then return o end
  if self:is_empty() then self.name, self.count, self.wear = o.name, o.count, o.wear return ItemStack("") end
  if o.name ~= self.name then return o end
  local fit = math.min(self:get_free_space(), o:get_count())
  self.count = self.count + fit
  o:set_count(o:get_count() - fit)
  return o
end
function stackmeta:replace(o)
  o = ItemStack(o)
  self.name, self.count, self.wear = o.name, o.count, o.wear
  return true
end
function stackmeta:equals(o) o = ItemStack(o) return o.name == self.name and o.count == self.count and o.wear == self.wear end
stackmeta.__tostring = function(st) return st:to_string() end
ItemStack = function(s)
  local st = setmetatable({name = "", count = 0, wear = 0}, stackmeta)
  local store
  if getmetatable(s) == stackmeta then
    st.name, st.count, st.wear = s.name, s.count, s.wear
    store = table.copy(s.store or {})
  elseif type(s) == "string" then
    local n, c, w = s:match("^(%S+)%s*(%d*)%s*(%d*)")
    if n then st.name, st.count, st.wear = n, tonumber(c) or 1, tonumber(w) or 0 end
  elseif type(s) == "table" then
    st.name = type(s.name) == "string" and s.name or ""
    st.count = tonumber(s.count) or (st.name ~= "" and 1 or 0)
    st.wear = tonumber(s.wear) or 0
  end
  st.name = st.name:gsub("^:", "")
  if st.name == "" then st.count = 0 end
  st.meta, st.store = newmeta(store)
  return st
end
VoxelArea = setmetatable({}, anymeta)
PseudoRandom = function() return setmetatable({next = function() return 1 end}, anymeta) end
PcgRandom = PseudoRandom
Settings = function() return setmetatable({get = function() return nil end, get_bool = function() return nil end}, anymeta) end

core = setmetatable({}, {__index = function(t, k) return anyfn end})
minetest = core
core.registered_items = {}
core.registered_nodes = {}
core.registered_tools = {}
core.registered_craftitems = {}
core.registered_aliases = {}
core.registered_entities = {}
core.registered_chatcommands = {}
core.registered_privileges = {}
core.registered_abms = {}
core.registered_lbms = {}
core.registered_ores = {}
core.registered_decorations = {}
core.registered_biomes = {}
core.luaentities = {}
core.object_refs = {}
core.features = {}
core.CONTENT_AIR = 126
core.CONTENT_IGNORE = 127
core.LIGHT_MAX = 14
core.PLAYER_MAX_HP_DEFAULT = 20
core.settings = setmetatable({
  get = function() return nil end,
  get_bool = function(_, _, d) return d end,
  get_flags = function() return {} end,
}, anymeta)
local afters = {}
core.after = function(t, f, ...) afters[#afters+1] = {f, {...}} end
local function run_afters()
  local n = 0
  while #afters > 0 and n < 20 do
    local list = afters
    afters = {}
    for _, a in ipairs(list) do pcall(a[1], unpack(a[2])) end
    n = n + 1
  end
end
CURRENT_MOD = nil
core.get_current_modname = function() return CURRENT_MOD end
core.get_modpath = function(m) return MOD_PATHS[m] end
core.get_worldpath = function() return "/world" end
core.get_modnames = function() return MOD_LIST end
core.get_game_info = function() return {id = "nodecore", title = "NodeCore", path = "/game"} end
core.get_translator = function() return function(s, ...) local a = {...} return (tostring(s):gsub("@(%d)", function(i) return tostring(a[tonumber(i)]) end)) end end
core.translate = function(d, s) return "\27(T@" .. d .. ")" .. tostring(s) .. "\27E" end
core.get_us_time = function() return 0 end
core.get_gametime = function() return 0 end
core.get_day_count = function() return 0 end
core.get_timeofday = function() return 0.5 end
core.is_singleplayer = function() return true end
core.global_exists = function(n) return rawget(_G, n) ~= nil end
core.get_mapgen_setting = function() return nil end
core.get_mapgen_params = function() return {} end
core.get_content_id = function() return 1 end
core.get_name_from_content_id = function() return "air" end
core.get_dir_list = function(path, dirs) return listdir(normpath(path), dirs) end
core.log = function() end
core.debug = function() end
core.hash_node_position = function(p) return (p.z + 32768) * 65536 * 65536 + (p.y + 32768) * 65536 + p.x + 32768 end
core.pos_to_string = function(p) return "(" .. p.x .. "," .. p.y .. "," .. p.z .. ")" end
core.string_to_pos = function() return nil end
core.formspec_escape = function(s) return s end
core.colorize = function(_, s) return s end
core.get_color_escape_sequence = function() return "" end
core.get_background_escape_sequence = function() return "" end
core.strip_colors = function(s) return s end
local serial = {}
core.serialize = function(t) serial[#serial+1] = table.copy(t) return "#" .. #serial end
core.deserialize = function(s) local i = type(s) == "string" and tonumber(s:match("^#(%d+)$")) return i and table.copy(serial[i]) or nil end
do
  -- real base64: mods build names and textures with it
  local B = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  core.encode_base64 = function(s)
    s = tostring(s)
    local out = {}
    for i = 1, #s, 3 do
      local a, b, c = s:byte(i, i + 2)
      local n = (a << 16) | ((b or 0) << 8) | (c or 0)
      out[#out + 1] = B:sub((n >> 18) + 1, (n >> 18) + 1) .. B:sub(((n >> 12) & 63) + 1, ((n >> 12) & 63) + 1)
        .. (b and B:sub(((n >> 6) & 63) + 1, ((n >> 6) & 63) + 1) or "=")
        .. (c and B:sub((n & 63) + 1, (n & 63) + 1) or "=")
    end
    return table.concat(out)
  end
  core.decode_base64 = function(s)
    s = tostring(s):gsub("[^%w%+/]", "")
    local out, bits, n = {}, 0, 0
    for i = 1, #s do
      n = (n << 6) | (B:find(s:sub(i, i), 1, true) - 1)
      bits = bits + 6
      if bits >= 8 then
        bits = bits - 8
        out[#out + 1] = string.char((n >> bits) & 255)
      end
    end
    return table.concat(out)
  end
end
core.write_json = function() return "{}" end
core.parse_json = function() return nil end
core.sha1 = function() return "0" end
core.get_node = function() return {name = "air", param2 = 0} end
core.get_node_or_nil = core.get_node
core.dir_to_facedir = function() return 0 end
core.facedir_to_dir = function() return vector.new(0,0,1) end
core.wallmounted_to_dir = function() return vector.new(0,-1,0) end
core.request_insecure_environment = function() return nil end
core.get_player_privs = function() return {} end
core.get_connected_players = function() return {} end
core.register_alias = function(a, b) core.registered_aliases[a] = b end
core.register_alias_force = core.register_alias
core.registered_on_mods_loaded = {}
core.register_on_mods_loaded = function(f) core.registered_on_mods_loaded[#core.registered_on_mods_loaded+1] = f end
core.mkdir = function() return true end
core.get_mod_storage = function()
  local store = {}
  return setmetatable({
    get_string = function(_, k) return store[k] or "" end,
    set_string = function(_, k, v) store[k] = v end,
    get_int = function(_, k) return tonumber(store[k]) or 0 end,
    set_int = function(_, k, v) store[k] = v end,
    get_float = function(_, k) return tonumber(store[k]) or 0 end,
    set_float = function(_, k, v) store[k] = v end,
    contains = function(_, k) return store[k] ~= nil end,
    to_table = function() return {fields = store} end,
  }, anymeta)
end

local function register_item_raw(name, def)
  name = name:gsub("^:", "")
  def.groups = def.groups or {}
  def.name = name
  def.__mod = def.__mod or CURRENT_MOD
  core.registered_items[name] = def
  if def.type == "node" then core.registered_nodes[name] = def
  elseif def.type == "tool" then core.registered_tools[name] = def
  else core.registered_craftitems[name] = def end
end
core.register_item_raw = register_item_raw
core.register_item = function(name, def) def.type = def.type or "none" register_item_raw(name, def) end
core.register_node = function(name, def) def.type = "node" core.register_item(name, def) end
core.register_craftitem = function(name, def) def.type = "craft" core.register_item(name, def) end
core.register_tool = function(name, def) def.type = "tool" core.register_item(name, def) end
core.override_item = function(name, redef)
  local d = core.registered_items[name]
  if not d then return end
  for k, v in pairs(redef) do d[k] = v end
end
core.unregister_item = function(name)
  core.registered_items[name] = nil core.registered_nodes[name] = nil
  core.registered_tools[name] = nil core.registered_craftitems[name] = nil
end
core.register_entity = function(name, def) core.registered_entities[name:gsub("^:", "")] = def end
core.register_abm = function(def)
  if type(def) == "table" then def.__mod = def.__mod or CURRENT_MOD end
  core.registered_abms[#core.registered_abms+1] = def
end
local plain_register_abm = core.register_abm
core.register_lbm = function(def) core.registered_lbms[#core.registered_lbms+1] = def end
core.register_chatcommand = function(n, def) core.registered_chatcommands[n] = def end
core.register_privilege = function(n, def) core.registered_privileges[n] = def end
core.override_chatcommand = function() end

-- Plain Luanti crafting (the grid, furnace cooking, fuel)
local engine_crafts = {}
core.register_craft = function(def)
  if type(def) ~= "table" then return end
  def.__mod = CURRENT_MOD
  engine_crafts[#engine_crafts + 1] = def
end
core.clear_craft = function() end

-- What map generation places: these are found in the world, not made
local world = {}
local function worldname(v)
  if type(v) == "string" then world[(v:gsub("^:", ""))] = true
  elseif type(v) == "table" then for _, x in ipairs(v) do worldname(x) end end
end
core.register_ore = function(def)
  if type(def) == "table" then worldname(def.ore) end
end
-- a schematic is handed back as it is, so decorations using it can be read
core.register_schematic = function(def) return def end
core.register_decoration = function(def)
  if type(def) ~= "table" then return end
  worldname(def.decoration)
  local sch = def.schematic
  if type(sch) == "table" and type(sch.data) == "table" then
    for _, e in pairs(sch.data) do
      if type(e) == "table" and type(e.name) == "string" and e.name ~= "air" and e.name ~= "ignore" then worldname(e.name) end
    end
  end
end
local BIOME_NODES = {"node_top", "node_filler", "node_stone", "node_water_top", "node_water", "node_river_water",
  "node_riverbed", "node_dust", "node_cave_liquid", "node_dungeon", "node_dungeon_alt", "node_dungeon_stair"}
core.register_biome = function(def)
  if type(def) ~= "table" then return end
  for _, f in ipairs(BIOME_NODES) do worldname(def[f]) end
end

core.register_node(":air", {groups = {}, drawtype = "airlike", walkable = false, buildable_to = true, pointable = false})
core.register_node(":ignore", {groups = {}, drawtype = "airlike"})
core.registered_items.air.__mod = "*engine"
core.registered_items.ignore.__mod = "*engine"

-- Every other function of Luanti's API (doc/lua_api.md), as a no-op that
-- answers with a stand-in. They have to really be in `core`: NodeCore
-- copies the engine API into `nc` by walking it with pairs().
local ENGINE_API = [[
add_entity add_item add_node add_node_level add_particle add_particlespawner after auth_reload
ban_player bulk_set_node bulk_swap_node calculate_knockback cancel_shutdown_requests
change_player_privs chat_send_all chat_send_player check_for_falling check_password_entry
check_player_privs check_single_for_falling clear_craft clear_objects clear_registered_biomes
clear_registered_decorations clear_registered_ores clear_registered_schematics close_formspec
colorize colorspec_to_bytes colorspec_to_colorstring colorspec_to_table compare_block_status
compress cpdir create_detached_inventory create_schematic debug decode_base64 decompress
delete_area delete_particlespawner deserialize dig_node dir_to_facedir dir_to_fourdir
dir_to_wallmounted dir_to_yaw disconnect_player do_item_eat dynamic_add_media emerge_area
encode_base64 encode_png explode_scrollbar_event explode_table_event explode_textlist_event
facedir_to_dir find_node_near find_nodes_in_area find_nodes_in_area_under_air
find_nodes_with_meta find_path fix_light forceload_block forceload_free_block
format_chat_message formspec_escape fourdir_to_dir generate_decorations generate_ores
get_active_blocks get_all_craft_recipes get_artificial_light get_auth_handler
get_background_escape_sequence get_ban_description get_ban_list get_biome_data get_biome_id
get_biome_name get_color_escape_sequence get_connected_players get_content_id get_craft_recipe
get_craft_result get_current_modname get_day_count get_decoration_id get_dig_params get_dir_list
get_game_info get_gametime get_gen_notify get_heat get_hit_params get_humidity get_inventory
get_item_group get_loadable_blocks get_loaded_blocks get_mapgen_chunksize get_mapgen_edges
get_mapgen_object get_mapgen_params get_mapgen_setting get_mapgen_setting_noiseparams get_meta
get_mod_data_path get_mod_storage get_modnames get_modpath get_name_from_content_id
get_natural_light get_node get_node_boxes get_node_drops get_node_group get_node_level
get_node_light get_node_max_level get_node_or_nil get_node_raw get_node_timer get_noiseparams
get_objects_in_area get_objects_inside_radius get_password_hash get_perlin get_perlin_map
get_player_by_name get_player_information get_player_ip get_player_privs
get_player_window_information get_pointed_thing_position get_position_from_hash
get_server_max_lag get_server_status get_server_uptime get_spawn_level get_timeofday
get_tool_wear_after_use get_translated_string get_translator get_us_time get_value_noise
get_value_noise_map get_version get_voxel_manip get_worldpath global_exists handle_async
handle_node_drops has_feature hash_node_position hud_replace_builtin hypertext_escape
inventorycube ipc_cas ipc_get ipc_poll ipc_set is_area_protected is_colored_paramtype
is_creative_enabled is_nan is_player is_protected is_singleplayer is_valid_player_name is_yes
item_drop item_eat item_pickup item_place item_place_node item_place_object item_secondary_use
itemstring_with_color itemstring_with_palette kick_player line_of_sight load_area log mkdir
mod_channel_join mvdir node_dig node_punch notify_authentication_modified objects_in_area
objects_inside_radius override_chatcommand override_item parse_json parse_relative_number
path_exists place_node place_schematic place_schematic_on_vmanip player_exists
pointed_thing_to_face_pos pos_to_string privs_to_string punch_node raillike_group raycast
read_schematic record_protection_violation register_abm register_alias register_alias_force
register_allow_player_inventory_action register_async_dofile register_authentication_handler
register_biome register_can_bypass_userlimit register_chatcommand register_craft
register_craft_predict register_craftitem register_decoration register_entity
register_globalstep register_lbm register_mapgen_script register_node register_on_auth_fail
register_on_authplayer register_on_chat_message register_on_chatcommand register_on_cheat
register_on_craft register_on_dieplayer register_on_dignode register_on_generated
register_on_item_eat register_on_item_pickup register_on_joinplayer register_on_leaveplayer
register_on_liquid_transformed register_on_mapblocks_changed register_on_modchannel_message
register_on_mods_loaded register_on_newplayer register_on_placenode register_on_player_hpchange
register_on_player_inventory_action register_on_player_receive_fields register_on_prejoinplayer
register_on_priv_grant register_on_priv_revoke register_on_protection_violation
register_on_punchnode register_on_punchplayer register_on_respawnplayer
register_on_rightclickplayer register_on_shutdown register_ore register_portable_metatable
register_privilege register_schematic register_tool remove_detached_inventory remove_node
remove_player remove_player_auth request_http_api request_insecure_environment request_shutdown
rgba rmdir rollback_get_node_actions rollback_revert_actions_by rotate_and_place rotate_node
safe_file_write save_gen_notify send_join_message send_leave_message serialize
serialize_schematic set_gen_notify set_mapgen_params set_mapgen_setting
set_mapgen_setting_noiseparams set_node set_node_level set_noiseparams set_player_password
set_player_privs set_timeofday setting_get_pos sha1 sha256 show_death_screen show_formspec
somefunction sound_fade sound_play sound_stop spawn_falling_node spawn_tree spawn_tree_on_vmanip
string_to_area string_to_pos string_to_privs strip_background_colors strip_colors strip_escapes
strip_foreground_colors strip_param2_color swap_node time_to_day_night_ratio
transforming_liquid_add translate translate_n unban_player_or_ip unregister_biome
unregister_chatcommand unregister_item urlencode wallmounted_to_dir wrap_text write_json
yaw_to_dir
]]
for name in ENGINE_API:gmatch("%S+") do
  if rawget(core, name) == nil then
    core[name] = function() return setmetatable({}, anymeta) end
  end
end

-- NodeCore's api mod fills this in; until then, anything asked of it is a no-op
nc = setmetatable({}, {__index = function(t, k) return anyfn end})

-- `include` relative to whichever mod is loading
include = function(...)
  local parts = {...}
  table.insert(parts, 1, MOD_PATHS[CURRENT_MOD])
  if parts[#parts]:sub(-4) ~= ".lua" then parts[#parts] = parts[#parts] .. ".lua" end
  return dofile(table.concat(parts, "/"))
end

---------------------------------------------------------------------------
-- Recording NodeCore's hints and recipes as registered, keeping the raw
-- goal/reqs (nc.register_hint compiles them into closures).

local hints, wrapped = {}, {}
local function wrap_nc()
  local nc = rawget(_G, "nc")
  if type(nc) ~= "table" then return end
  local reg = rawget(nc, "register_hint")
  if type(reg) == "function" and not wrapped[reg] then
    local f = function(text, goal, reqs, ext, ...)
      local h = reg(text, goal, reqs, ext, ...)
      if type(text) ~= "table" then
        -- `.hide = true` is often set on the returned hint, so keep it
        hints[#hints + 1] = {text = text, goal = goal, reqs = reqs, ret = h, mod = CURRENT_MOD}
      end
      return h
    end
    wrapped[f] = true
    rawset(nc, "register_hint", f)
  end
  local aism = rawget(nc, "register_aism")
  if type(aism) == "function" and not wrapped[aism] then
    local f = function(def, ...)
      if type(def) == "table" and not def.__mod then def.__mod = CURRENT_MOD end
      return aism(def, ...)
    end
    wrapped[f] = true
    rawset(nc, "register_aism", f)
  end
  local craft = rawget(nc, "register_craft")
  if type(craft) == "function" and not wrapped[craft] then
    local f = function(recipe, ...)
      if type(recipe) == "table" and not recipe.__mod then recipe.__mod = CURRENT_MOD end
      return craft(recipe, ...)
    end
    wrapped[f] = true
    rawset(nc, "register_craft", f)
  end
end

---------------------------------------------------------------------------
-- Run every mod

local results = {mods = {}}
local MOD_BUDGET = 3000
for _, m in ipairs(MOD_LIST) do
  CURRENT_MOD = m
  wrap_nc()
  -- a budget per mod, so one stuck in a loop cannot hang the page
  local ticks = 0
  debug.sethook(function()
    ticks = ticks + 1
    if ticks > MOD_BUDGET then error("took too long to load (stopped after " .. MOD_BUDGET .. "00k Lua steps)", 2) end
  end, "", 100000)
  local ok, err = xpcall(dofile, debug.traceback, MOD_PATHS[m] .. "/init.lua")
  debug.sethook()
  results.mods[#results.mods + 1] = {name = m, ok = ok,
    error = (not ok) and tostring(err):sub(1, 1500) or nil}
  wrap_nc()
  if m == "nc_api" and type(nc) == "table" then
    -- From here on NodeCore's API is real: a field it leaves nil must read
    -- as nil (`nc.x = nc.x or default` is common), not as a stand-in.
    setmetatable(nc, nil)
  end
  if m == "nc_api" and type(rawget(nc, "item_matching_index")) == "function" then
    -- Lookup indexes for matching items at run time: rebuilt over every
    -- registered item whenever a recipe is added, and never read here.
    -- (In Fengari this alone takes most of the load.)
    nc.item_matching_index = function() return {}, function() end end
  end
  if m == "nc_api_active" then
    -- ABM multiplexing re-groups every node each time an ABM is added;
    -- ABMs only matter in a running world.
    core.register_abm = plain_register_abm
  end
end
CURRENT_MOD = nil
run_afters()
for _, f in ipairs(core.registered_on_mods_loaded) do pcall(f) end
run_afters()

---------------------------------------------------------------------------
-- Probing ABMs: run each one on a block it applies to, in a tiny pretend
-- world holding the neighbours it asks for, and note what the block (or
-- anything beside it) turns into. That catches the changes game code makes
-- (concrete wetting and curing, lode cooling, ...) that no recipe lists.

local probe_world, probe_meta, probe_changes, probe_drops = {}, {}, {}, {}
local probe_spot = 0
local function pkey(p) return math.floor(p.x + 0.5) .. "," .. math.floor(p.y + 0.5) .. "," .. math.floor(p.z + 0.5) end
local function groupof(name, g)
  local d = core.registered_items[name]
  return d and d.groups and d.groups[g] or 0
end
local function matches(name, spec)
  if type(spec) == "string" then spec = {spec} end
  if type(spec) ~= "table" then return false end
  for _, s in ipairs(spec) do
    if s == name then return true end
    if type(s) == "string" and s:sub(1, 6) == "group:" then
      local ok = true
      for g in s:sub(7):gmatch("[^,]+") do if (tonumber(groupof(name, g)) or 0) <= 0 then ok = false end end
      if ok then return true end
    end
  end
  return false
end
local function expand(spec)
  local out = {}
  for name, def in pairs(core.registered_nodes) do
    if name ~= "air" and name ~= "ignore" and matches(name, spec) then out[#out + 1] = name end
  end
  table.sort(out)
  return out
end

local function setnode(pos, node)
  local k = pkey(pos)
  local old = probe_world[k] and probe_world[k].name or "air"
  local name = type(node) == "table" and node.name or node
  probe_world[k] = {name = name, param2 = type(node) == "table" and node.param2 or 0}
  if name ~= old then probe_changes[#probe_changes + 1] = {pos = k, from = old, to = name} end
end
local real = {}
for _, f in ipairs({"get_node", "get_node_or_nil", "set_node", "swap_node", "add_node", "remove_node",
  "find_node_near", "find_nodes_in_area", "get_meta", "add_item", "get_node_light", "get_natural_light",
  "get_gametime", "get_item_group"}) do real[f] = core[f] end

local function probe_api(on)
  if not on then for k, v in pairs(real) do core[k] = v end return end
  core.get_node = function(p) return probe_world[pkey(p)] or {name = "air", param2 = 0} end
  core.get_node_or_nil = core.get_node
  core.set_node = setnode
  core.swap_node = setnode
  core.add_node = setnode
  core.remove_node = function(p) setnode(p, {name = "air"}) end
  core.add_item = function(p, item)
    local n = type(item) == "string" and item:match("^(%S+)") or (type(item) == "table" and item.get_name and item:get_name())
    if n and n ~= "" then probe_drops[#probe_drops + 1] = n end
  end
  core.get_node_light = function() return 15 end
  core.get_natural_light = function() return 15 end
  core.get_item_group = groupof
  local function within(minp, maxp, names)
    local out = {}
    for k, n in pairs(probe_world) do
      local x, y, z = k:match("(-?%d+),(-?%d+),(-?%d+)")
      x, y, z = tonumber(x), tonumber(y), tonumber(z)
      if x >= minp.x and x <= maxp.x and y >= minp.y and y <= maxp.y and z >= minp.z and z <= maxp.z
        and matches(n.name, names) then out[#out + 1] = vector.new(x, y, z) end
    end
    return out
  end
  core.find_nodes_in_area = function(a, b, names)
    local minp, maxp = vector.sort(a, b)
    return within(minp, maxp, names)
  end
  core.find_node_near = function(p, r, names)
    return within(vector.subtract(p, r), vector.add(p, r), names)[1]
  end
  core.get_meta = function(p)
    local k = pkey(p)
    probe_meta[k] = probe_meta[k] or {}
    local m = probe_meta[k]
    return setmetatable({
      get_string = function(_, f) return m[f] and tostring(m[f]) or "" end,
      set_string = function(_, f, v) m[f] = v end,
      get_int = function(_, f) return math.floor(tonumber(m[f]) or 0) end,
      set_int = function(_, f, v) m[f] = v end,
      get_float = function(_, f) return tonumber(m[f]) or 0 end,
      set_float = function(_, f, v) m[f] = v end,
      contains = function(_, f) return m[f] ~= nil end,
      to_table = function() return {fields = m, inventory = {}} end,
      from_table = function() end,
      mark_as_private = function() end,
    }, anymeta)
  end
end

-- Things worth having beside a block or stack when probing: what ABMs
-- most often look for (water, fire, lava, lux), tried one at a time.
local ENVIRONMENT = {"nc_terrain:water_source", "nc_fire:fire", "nc_terrain:lava_source", "nc_lux:flux_source",
  "nc_terrain:dirt"}
local MAX_SUBJECTS = 150
local STEPS, TRIALS = 40, 2

local function in_scope(def, subject)
  if PROBE_ABMS == true then return true end
  local scope = PROBE_ABMS
  if scope[def.__mod or ""] then return true end
  local d = core.registered_items[subject]
  return d and scope[d.__mod or ""] or false
end

-- Run `tick(origin, node_at_origin)` STEPS times in a fresh pretend world
-- with `subject` at the origin (as a node, or a stack lying there) and
-- `hood` beside it; return the changes seen.
local function probe_run(subject, hood, as_stack, tick, budget)
  probe_world, probe_meta, probe_changes, probe_drops = {}, {}, {}, {}
  -- a fresh spot each time: NodeCore caches some state by position
  probe_spot = probe_spot + 1
  local ox = probe_spot * 16
  local origin = vector.new(ox, 0, 0)
  local here = pkey(origin)
  probe_world[here] = {name = as_stack and "nc_items:stack" or subject, param2 = 0}
  if hood then probe_world[pkey(vector.new(ox + 1, 0, 0))] = {name = hood, param2 = 0} end
  -- a solid floor, so nothing falls out of the pretend world
  probe_world[pkey(vector.new(ox, -1, 0))] = {name = "nc_terrain:stone", param2 = 0}
  local ticks = 0
  debug.sethook(function() ticks = ticks + 1 if ticks > budget then error("probe budget") end end, "", 10000)
  local stack = as_stack and ItemStack(subject) or nil
  local outs = {}
  for step = 1, STEPS do
    -- (the game clock: soaking ABMs measure progress by it; it jumps further
    -- each step, so slow ones such as composting finish within the steps)
    nc.gametime = (rawget(nc, "gametime") or 0) + 10 * 2 ^ math.min(step, 24)
    if as_stack then
      local result
      local ok, ret = pcall(tick, stack, {pos = origin, node = probe_world[here], set = function(st) result = st end})
      result = result or (ok and ret) or nil
      if result then
        local st = ItemStack(result)
        if st:get_name() ~= subject then
          if st:get_name() ~= "" then outs[st:get_name()] = true end
          break
        end
        stack = st
      end
      if stack:is_empty() then break end
    else
      local node = probe_world[here]
      if not node or node.name ~= subject then break end
      pcall(tick, origin, {name = node.name, param2 = node.param2}, 1, 1)
    end
  end
  debug.sethook()
  for _, c in ipairs(probe_changes) do
    if as_stack then
      -- a stack can set a node beside it (wet concrete poured into water)
      if c.to ~= "air" and c.to ~= "nc_items:stack" and c.to ~= subject then outs[c.to] = true end
    elseif c.pos == here and c.from == subject and c.to ~= subject then
      outs[c.to] = true
    end
  end
  for _, d in ipairs(probe_drops) do outs[d] = true end
  return outs
end

local function probe_def(def, kind, subjects, hoods, budget, found)
  local tick = def.action
  for _, subject in ipairs(subjects) do
    if in_scope(def, subject) then
      local plain = {}
      for _, hood in ipairs(hoods) do
        for trial = 1, TRIALS do
          for out in pairs(probe_run(subject, hood, kind == "aism", tick, budget)) do
            -- a change that happens anyway needs nothing beside it
            if not hood then plain[out] = true end
            if (not hood or not plain[out]) and out ~= subject then
              found[kind .. subject .. ">" .. out .. ">" .. tostring(hood)] = {
                from = subject, to = out, with = hood or nil, label = def.label, kind = kind, mod = def.__mod}
            end
          end
        end
      end
    end
  end
end

local abm_found, abm_skipped = {}, {}
if PROBE_ABMS then
  probe_api(true)
  local env = {false}
  for _, n in ipairs(ENVIRONMENT) do if core.registered_nodes[n] then env[#env + 1] = n end end
  local found = {}
  for _, def in ipairs(core.registered_abms) do
    if type(def) == "table" and type(def.action) == "function" then
      local subjects = expand(def.nodenames)
      if #subjects > MAX_SUBJECTS then
        abm_skipped[#abm_skipped + 1] = {label = def.label, nodes = #subjects}
      else
        local hoods = env
        if def.neighbors then
          hoods = {}
          for _, n in ipairs(expand(def.neighbors)) do hoods[#hoods + 1] = n end
          if #hoods > 6 then hoods = {hoods[1], hoods[2], hoods[3]} end
        end
        pcall(probe_def, def, "abm", subjects, hoods, 300, found)
      end
    end
  end
  for _, def in ipairs(type(rawget(nc, "registered_aisms")) == "table" and nc.registered_aisms or {}) do
    if type(def) == "table" and type(def.action) == "function" then
      local subjects = {}
      for name in pairs(core.registered_items) do
        if name ~= "" and name ~= "air" and name ~= "ignore" and matches(name, def.itemnames) then subjects[#subjects + 1] = name end
      end
      table.sort(subjects)
      if #subjects > MAX_SUBJECTS then
        abm_skipped[#abm_skipped + 1] = {label = def.label, items = #subjects}
      else
        pcall(probe_def, def, "aism", subjects, env, 300, found)
      end
    end
  end
  for _, f in pairs(found) do abm_found[#abm_found + 1] = f end
  table.sort(abm_found, function(x, y) return (x.from .. x.to .. (x.with or "")) < (y.from .. y.to .. (y.with or "")) end)
  probe_api(false)
  debug.sethook()
end
results.abm_changes = abm_found
results.abm_skipped = abm_skipped

---------------------------------------------------------------------------
-- Read back what was registered, as JSON

local function str(s)
  if type(s) ~= "string" then return nil end
  -- strip translation and colour escapes
  s = s:gsub("\27%(T@[^)]*%)", ""):gsub("\27[EF]", ""):gsub("\27%([^)]*%)", ""):gsub("\27.", "")
  return s
end

-- a goal/reqs spec: string, list (first element `true` = any), function or nil
local function spec(v)
  if v == nil then return {op = "always", keys = {}} end
  if type(v) == "string" then return {op = "and", keys = {v}} end
  if type(v) == "function" then return {op = "func", keys = {}} end
  if type(v) == "table" then
    local keys, op, start = {}, "and", 1
    if v[1] == true then op, start = "or", 2 end
    for i = start, #v do if type(v[i]) == "string" then keys[#keys + 1] = v[i] end end
    return {op = op, keys = keys}
  end
  return {op = "func", keys = {}}
end

local function plain(v, depth)
  depth = depth or 0
  local t = type(v)
  if t == "string" then return v end
  if t == "number" or t == "boolean" then return v end
  if t ~= "table" or depth > 5 or getmetatable(v) == anymeta then return nil end
  local out = {}
  for k, x in pairs(v) do
    if type(k) == "string" or type(k) == "number" then
      local p = plain(x, depth + 1)
      if p ~= nil then out[k] = p end
    end
  end
  return out
end

local function match_of(m)
  if type(m) == "string" then return {name = m} end
  if type(m) ~= "table" then return nil end
  local o = {name = type(m.name) == "string" and m.name or nil, count = tonumber(m.count)}
  if type(m.groups) == "table" then
    o.groups = {}
    for g in pairs(m.groups) do if type(g) == "string" then o.groups[#o.groups + 1] = g end end
  end
  if not o.name and not o.groups then o.other = true end
  return o
end

local function caps_of(def)
  local tc = type(def) == "table" and type(def.tool_capabilities) == "table" and def.tool_capabilities.groupcaps
  if type(tc) ~= "table" then return nil end
  local caps = {}
  for g, gv in pairs(tc) do
    local lv = {}
    if type(gv) == "table" and type(gv.times) == "table" then
      for k in pairs(gv.times) do if type(k) == "number" then lv[#lv + 1] = k end end
    end
    table.sort(lv)
    caps[g] = lv
  end
  return caps
end

TRANSFORM_FIELDS = {"drop_in_place", "drop_as", "drop_non_silktouch", "silktouch_as", "lode_alt_hot",
  "lode_alt_annealed", "lode_alt_tempered", "tool_wears_to", "repack_to", "alternative_lux_infused",
  "flower_wilts_to", "soil_degrades_to", "leaf_decay_as", "on_ignite"}

local items = {}
for name, def in pairs(core.registered_items) do
  if name ~= "air" and name ~= "ignore" and name ~= "" then
    local caps = caps_of(def)
    local drop
    if type(def.drop) == "string" then drop = {def.drop}
    elseif type(def.drop) == "table" and type(def.drop.items) == "table" then
      drop = {}
      for _, e in ipairs(def.drop.items) do
        if type(e) == "table" and type(e.items) == "table" then
          for _, s in ipairs(e.items) do if type(s) == "string" then drop[#drop + 1] = s end end
        end
      end
    end
    local groups = {}
    for g, v in pairs(def.groups or {}) do
      if type(g) == "string" and v ~= 0 and v ~= false then groups[g] = tonumber(v) or 1 end
    end
    -- fields NodeCore uses to turn one item into another in the world
    local transforms
    for _, f in ipairs(TRANSFORM_FIELDS) do
      local v = def[f]
      local vn = type(v) == "string" and v or (type(v) == "table" and type(v.name) == "string" and v.name) or nil
      if vn and vn ~= "" then
        transforms = transforms or {}
        transforms[f] = vn:gsub("^:", "")
      end
    end
    items[name] = {
      type = def.type, description = str(def.description), groups = groups,
      toolcaps = caps, drop = drop, mod = def.__mod, transforms = transforms,
      hidden = (def.groups and def.groups.not_in_creative_inventory) and true or nil,
    }
  end
end

local crafts = {}
for _, d in ipairs(engine_crafts) do
  crafts[#crafts + 1] = {type = d.type or "shaped", output = d.output, recipe = plain(d.recipe),
    replacements = plain(d.replacements), cooktime = d.cooktime, burntime = d.burntime, mod = d.__mod}
end

local recipes = {}
local reglist = type(rawget(nc, "registered_recipes")) == "table" and nc.registered_recipes or {}
for _, r in ipairs(reglist) do
  local nodes = {}
  for _, n in ipairs(type(r.nodes) == "table" and r.nodes or {}) do
    nodes[#nodes + 1] = {x = n.x, y = n.y, z = n.z, match = match_of(n.match),
      replace = type(n.replace) == "string" and n.replace or (type(n.replace) == "table" and n.replace.name) or nil}
  end
  local outs = {}
  for _, it in pairs(type(r.items) == "table" and r.items or {}) do
    if type(it) == "table" and type(it.name) == "string" then
      outs[#outs + 1] = {name = it.name, count = tonumber(it.count) or 1}
    end
  end
  local tg
  if type(r.toolgroups) == "table" then
    tg = {}
    for g, lv in pairs(r.toolgroups) do if type(g) == "string" then tg[g] = tonumber(lv) or 1 end end
  end
  recipes[#recipes + 1] = {label = str(r.label), action = r.action, nodes = nodes, items = outs,
    wield = match_of(r.wield), toolgroups = tg, mod = r.__mod}
end

local hintout = {}
for _, h in ipairs(hints) do
  hintout[#hintout + 1] = {text = str(h.text), goal = spec(h.goal), reqs = spec(h.reqs), hide = (type(h.ret) == "table" and h.ret.hide) and true or nil, mod = h.mod}
end

local aliases = {}
for a, b in pairs(core.registered_aliases) do
  if type(b) == "string" then
    aliases[a] = b
    if a:sub(1, 7) == "mapgen_" then worldname(b) end
  end
end
-- NodeCore's stone strata and nodes it hands to the mapgen by name
for name, def in pairs(core.registered_items) do
  if type(def.strata) == "table" then worldname(def.strata) end
  if def.mapgen then worldname(name) end
end
local worldlist = {}
for n in pairs(world) do if items[n] then worldlist[#worldlist + 1] = n end end
table.sort(worldlist)
results.world = worldlist

-- ask each leaf-drop callback what fully grown leaves would give
local leafout = {}
local function modof(fn)
  local src = debug.getinfo(fn, "S").source or ""
  return src:match("^@/mods/([^/]+)/")
end
for _, fn in ipairs(type(rawget(nc, "registered_leaf_drops")) == "table" and nc.registered_leaf_drops or {}) do
  local d = {fn = fn, mod = type(fn) == "function" and modof(fn) or nil}
  local list = {}
  if type(fn) == "function" then pcall(fn, vector.new(0, 0, 0), {name = "nc_tree:leaves", param2 = 4}, list) end
  for _, e in ipairs(list) do
    local n = type(e) == "string" and e or (type(e) == "table" and e.name)
    if type(n) == "string" and n ~= "" then leafout[#leafout + 1] = {name = (n:gsub("%s.*$", "")), mod = d.mod} end
  end
end
results.leaf_drops = leafout
results.items = items
results.hand = caps_of(core.registered_items[""])
results.crafts = crafts
results.nc_recipes = recipes
results.hints = hintout
results.aliases = aliases

-- JSON
local function esc(s)
  return '"' .. s:gsub('[%c"\\]', function(c)
    local m = {['"'] = '\\"', ['\\'] = '\\\\', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t'}
    return m[c] or string.format("\\u%04x", c:byte())
  end) .. '"'
end
local function isarray(t)
  local n = 0
  for k in pairs(t) do
    if type(k) ~= "number" or k < 1 or k % 1 ~= 0 then return false end
    n = n + 1
  end
  return n == #t
end
local function enc(v, buf)
  local t = type(v)
  if t == "nil" then buf[#buf + 1] = "null"
  elseif t == "boolean" then buf[#buf + 1] = tostring(v)
  elseif t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then buf[#buf + 1] = "null"
    elseif v % 1 == 0 and math.abs(v) < 2^53 then buf[#buf + 1] = string.format("%d", v)
    else buf[#buf + 1] = string.format("%.14g", v) end
  elseif t == "string" then buf[#buf + 1] = esc(v)
  elseif t == "table" then
    if next(v) == nil then buf[#buf + 1] = "[]" return end
    if isarray(v) then
      buf[#buf + 1] = "["
      for i, x in ipairs(v) do if i > 1 then buf[#buf + 1] = "," end enc(x, buf) end
      buf[#buf + 1] = "]"
    else
      buf[#buf + 1] = "{"
      local first = true
      for k, x in pairs(v) do
        if (type(k) == "string" or type(k) == "number") and type(x) ~= "function" then
          if not first then buf[#buf + 1] = "," end
          first = false
          buf[#buf + 1] = esc(tostring(k))
          buf[#buf + 1] = ":"
          enc(x, buf)
        end
      end
      buf[#buf + 1] = "}"
    end
  else buf[#buf + 1] = "null" end
end
local buf = {}
enc(results, buf)
return table.concat(buf)
