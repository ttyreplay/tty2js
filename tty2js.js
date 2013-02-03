#!/usr/bin/env node

// parse the command line
var program = require('commander')

program
  .usage('<input file.tty> <output file.js>')
  .option('-r, --rows <n>', 'Number of rows in the broadcasting terminal', parseInt, 25)
  .option('-c, --columns <n>', 'Number of columns in the broadcasting terminal', parseInt, 80)
  .option('-s, --size <CxR>', 'Size of the terminal (shorthand for combination of -c and -r)')
  .option('-C, --current', 'Use the current terminal\'s size')
  .parse(process.argv)

var rows = program.rows
  , cols = program.columns

if (program.size) {
  var m = program.size.match(/^(\d+)x(\d+)$/i)
  if (!m) {
    console.log('Invalid size specified! Must be in form CxR')
    program.help()
  }
  cols = parseInt(m[1], 10)
  rows = parseInt(m[2], 10)
}


if (program.current) {
  rows = process.stdout.rows
  cols = process.stdout.columns
}

if (program.args.length < 2) {
  console.log('want 2 args! input and output')
  process.exit(1)
}

var fs = require('fs')
  , binary = require('binary')

var HeadlessTerminal = require('headless-terminal')
  , term = new HeadlessTerminal(cols, rows)
  , ScreenBuffer = HeadlessTerminal.ScreenBuffer
  , patcher = HeadlessTerminal.patcher

term.open()


var data = fs.readFileSync(program.args[0])
var chain = binary.parse(data)

var display = null
  , count = 0
  , frames = []
  , odometer = 0

function updateScreen(time) {
  var keyframe = false
  if (display == null) {
    keyframe = true
    display = new ScreenBuffer()
    count = 0
  }
  var ops = patcher.patch(display, term.displayBuffer)
  var frame = { key: keyframe, time: Math.round(time), ops: ops }
  count += 1
  if (count >= 128) display = null
  frames.push(frame)
  d.setTime(time)
  process.stdout.write('\rframe ' + frames.length + ' (' + (odometer - frames.length) + ' skipped' + ' @ ' + d.toString())
}

function delayed(func, delay) {
  var schedule = null
  function tick(time) {
    if (schedule != null && time >= schedule) {
      func(schedule)
      schedule = null
    }
    if (schedule == null) {
      schedule = time + delay
    }
  }
  return tick
}

var d = new Date()
  , decoder = new (require('string_decoder').StringDecoder)()
  , delayedUpdateScreen = delayed(updateScreen, 1000 / 29.97)
  , lastTime = 0
while (!chain.eof()) {
  chain
    .flush()
    .word32lu('sec')
    .word32lu('usec')
    .word32lu('size')
    .tap(function(vars) {
      this.buffer('data', vars.size)
        .tap(function(vars) {
          var data = decoder.write(vars.data)
            , time = lastTime = vars.sec * 1000 + vars.usec / 1000
          delayedUpdateScreen(time)
          term.write(data)
          odometer += 1
        })
    })
}

delayedUpdateScreen(Infinity)

function nameGenerator() {
  var charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ$_abcdefghijklmnopqrstuvwxyz1234567890'
  function base(n) {
    var i = 0
      , append = null
      , rest = ''
    return function() {
      var out = charset[i]
      i ++
      if (i >= n) {
        if (append == null) append = base(charset.length)
        rest = append()
        i = 0
      }
      return out + rest
    }
  }
  return base(28)
}

var pool = function() {
  var map = {}
    , out = {}
    , output = { declaration: [], data: [] }
  function remember(obj) {
    var text = JSON.stringify(obj)
    map[text] = (map[text] || 0) + 1
  }
  function process() {
    var list = []
    for (var i in map) if (map.hasOwnProperty(i)) list.push({ code: i, count: map[i] })
    list.forEach(function(c) {
      c.total = c.code.length * c.count
    })
    list.sort(function(a, b) { return b.total - a.total })
    var varName = nameGenerator()
    list.forEach(function(c) {
      c.name = varName()
      c.saving = c.total - c.name.length * c.count - 3 - c.name.length - c.code.length
    })
    list.forEach(function(c) {
      if (c.saving > 0) {
        output.declaration.push(c.name)
        output.data.push(c.code)
        out[c.code] = c.name
      }
    })
  }
  function get(s) {
    if (out.hasOwnProperty(s)) return out[s]
    return s
  }
  return { remember: remember, process: process, get: get, output: output }
}()

frames.forEach(function(frame) {
  frame.ops.forEach(function(op) {
    if (op[0] == 'draw') {
      pool.remember(op[3])
      pool.remember(op[4])
    }
  })
})

pool.process()

function fmt() {
  var args = [].slice.call(arguments)
  return args.shift().replace(/(%j)|(%s)/g, function(x, j, s) {
    if (j) return pool.get(JSON.stringify(args.shift()))
    else return args.shift()
  })
}

function stringifyOp(op) {
  if (op[0] == 'draw') {
    return fmt('d(%j,%j,%j,%j)', op[1], op[2], op[3], op[4])
  }
  if (op[0] == 'setCursor') {
    return fmt('c(%j,%j)', op[1], op[2])
  }
  if (op[0] == 'copy') {
    return fmt('p(%j,%j)', op[1], op[2])
  }
  return JSON.stringify(op)
}

function stringifyFrame(frame) {
  return (
    (frame.key ? 'k' : 'f') + '('
  + JSON.stringify(frame.time) + ','
  + '[' + frame.ops.map(stringifyOp).join(',') + ']'
  + ')'
  )
}

console.log('\n')
console.log('Writing JS file')
fs.writeFileSync(program.args[1],
  ';(function(' + pool.output.declaration.join(',') + '){'
+ 'function k(t,o){return {key:true,time:t,ops:o}}'
+ 'function f(t,o){return {key:false,time:t,ops:o}}'
+ 'function d(r,c,t,a){return ["draw",r,c,t,a]}'
+ 'function c(r,c){return ["setCursor",r,c]}'
+ 'function p(t,s){return ["copy",t,s]}'
+ 'loadFrames(\n[' + frames.map(stringifyFrame).join('\n,') + '])})(\n '
+ pool.output.data.join('\n,') + ')')

console.log('yeah done')

