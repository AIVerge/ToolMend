#!/usr/bin/env node
'use strict';
/* ToolMend CLI wrapper: maps flags onto the env vars the proxy reads. */
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args.includes('--help') || args.includes('-h')) {
  console.log(`ToolMend — repair broken tool calls from your LLM backend

Usage:
  toolmend [--port 29090] [--host 127.0.0.1] [--upstream http://127.0.0.1:8080]
           [--log ./toolmend.log] [--no-autocontinue] [--no-marker]
  toolmend --selftest                 run the built-in test suite (no network)
  toolmend --probe "text" --loop --tok 40   ask the stall detector about a text

Point your agent client at ToolMend, e.g.:
  ANTHROPIC_BASE_URL=http://127.0.0.1:29090
`);
  process.exit(0);
}
const set = (k, v) => { if (v !== undefined) process.env[k] = v; };
set('LISTEN_PORT', flag('--port'));
set('LISTEN_HOST', flag('--host'));
set('UPSTREAM', flag('--upstream'));
set('TOOLMEND_LOG', flag('--log'));
if (args.includes('--no-autocontinue')) process.env.DSML_AUTOCONTINUE = '0';
if (args.includes('--no-marker')) process.env.DSML_AUTOCONTINUE_MARK = '0';
require('../src/toolmend.js');
