'use strict';
/** One line per event: "YYYY-MM-DD HH:MM:SS  <text>" to stdout and, if set, the log file. */
const fs = require('node:fs');

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

function makeClock(timezone) {
  if (!timezone) {
    return (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  return (d) => {
    const p = {};
    for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
    return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute + ':' + p.second;
  };
}

class Logger {
  constructor(cfg) {
    this.file = cfg.log_file || '';
    this.clock = makeClock(cfg.timezone || '');
  }

  say(text) {
    const line = this.clock(new Date()) + '  ' + text + '\n';
    process.stdout.write(line);
    if (this.file !== '') {
      try { fs.appendFileSync(this.file, line); } catch (e) { /* like the reference: logging never stops the node */ }
    }
  }
}

module.exports = { Logger };
