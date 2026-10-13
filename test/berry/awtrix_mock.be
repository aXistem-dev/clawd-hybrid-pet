# A tiny stand-in for the AWTRIX NG script runtime, just enough to run the
# Clawd scripts under a desktop Berry interpreter. Everything is recorded so
# tests can look at what the script did.
import string

# ---- clock -------------------------------------------------------------------
_now = 100000
_epoch = 1790500000000
_hour = 10
def now_ms() return _now end
def epoch_ms() return _epoch end
def hour() return _hour end
def advance(ms)
  _now += ms
  if _epoch > 0 _epoch += ms end
end

# ---- panel -------------------------------------------------------------------
fb = []
for i : 0 .. 255 fb.push(0) end
texts = []
scroll_runs = 0
def width() return 32 end
def height() return 8 end
def clear()
  for i : 0 .. 255 fb[i] = 0 end
  texts = []
end
def pixel(x, y, c)
  if x >= 0 && x < 32 && y >= 0 && y < 8 fb[y * 32 + x] = c end
end
def px(x, y) return fb[y * 32 + x] end
def line(x0, y0, x1, y1, c)
  var dx = x1 > x0 ? x1 - x0 : x0 - x1
  var dy = y1 > y0 ? y0 - y1 : y1 - y0
  var sx = x0 < x1 ? 1 : -1
  var sy = y0 < y1 ? 1 : -1
  var err = dx + dy
  while true
    pixel(x0, y0, c)
    if x0 == x1 && y0 == y1 break end
    var e2 = 2 * err
    if e2 >= dy err += dy x0 += sx end
    if e2 <= dx err += dx y0 += sy end
  end
end
def rect_fill(x, y, w, h, c)
  for yy : y .. y + h - 1
    for xx : x .. x + w - 1 pixel(xx, yy, c) end
  end
end
def text(x, y, s, c)
  texts.push([x, y, s, c])
  return size(s) * 4
end
def text_ink_width(s) return size(s) * 4 - 1 end
def scroll_text(s, c)
  texts.push([0, 6, s, c])
  return scroll_runs
end
def lit()          # how many pixels are on
  var n = 0
  for v : fb if v != 0 n += 1 end end
  return n
end

# ---- services ------------------------------------------------------------------
class MockStore
  var m
  def init() self.m = {} end
  def get(k, d)
    var v = self.m.find(k)
    return v == nil ? d : v
  end
  def set(k, v) self.m[k] = v end
end
store = MockStore()

class MockMqtt
  var pub, subs
  def init() self.pub = [] self.subs = {} end
  def publish(t, p) self.pub.push([t, p]) end
  def subscribe(t, cb) self.subs[t] = cb end
  def deliver(t, p) self.subs[t](t, p) end
end
mqtt = MockMqtt()

class MockSound
  var played
  def init() self.played = [] end
  def rtttl(s) self.played.push(s) return true end
  def play(x) self.played.push(x['rtttl']) return true end
end
sound = MockSound()

class MockRotation
  var paused, shown
  def init() self.paused = false self.shown = 0 end
  def pause() self.paused = true end
  def resume() self.paused = false end
  def show() self.shown += 1 return true end
end
rotation = MockRotation()

notes = []
def notify(m) notes.push(m) return true end
logs = []
def log(v) logs.push(str(v)) end
def clamp(v, lo, hi) return v < lo ? lo : (v > hi ? hi : v) end
def min(a, b) return a < b ? a : b end
def max(a, b) return a > b ? a : b end

def reset_services()
  store = MockStore()
  mqtt = MockMqtt()
  sound = MockSound()
  rotation = MockRotation()
  notes = []
  logs = []
end

# ---- helpers for tests --------------------------------------------------------------
failures = 0
def check(cond, msg)
  if !cond
    print("  FAIL: " + msg)
    failures += 1
  end
end

def read_file(p)
  var f = open(p)
  var s = f.read()
  f.close()
  return s
end

# Load a script with its @config defaults put into the store first, the way the
# device does before init() runs.
def load_config(src)
  for ln : string.split(src, "\n")
    if string.find(ln, "# @config") == 0
      var parts = string.split(ln, " ")
      var key = nil
      var typ = nil
      for p : parts
        if p == "" || p == "#" || p == "@config" continue end
        if key == nil key = p continue end
        if typ == nil typ = p continue end
        if string.find(p, "default=") == 0
          var v = string.split(p, "=")[1]
          v = string.tr(v, "\"", "")
          if typ == "bool" v = v == "true"
          elif typ == "number" v = real(v) end
          store.set(key, v)
        end
      end
    end
  end
end

def load_app(path, overrides)
  var src = read_file(path)
  load_config(src)
  if overrides != nil
    for k : overrides.keys() store.set(k, overrides[k]) end
  end
  return compile(src)()
end
