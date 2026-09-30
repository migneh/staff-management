'use strict';
/**
 * تسهّل الاختبارات: إذا تعذّر بناء وحدة better-sqlite3 الأصلية (بيئة بدون node-gyp
 * أو بدون headers)، نستخدم node:sqlite المدمج في Node 22 خلف نفس الواجهة.
 * لا يُغيّر أي شيء في بيئة الإنتاج — يُفعَّل فقط عند فشل التحميل الأصلي.
 */
const Module = require('module');

function nativeWorks() {
  try {
    const Db = require('better-sqlite3');
    const db = new Db(':memory:');
    db.exec('CREATE TABLE t (a INTEGER)');
    db.prepare('INSERT INTO t VALUES (?)').run(1);
    db.close();
    return true;
  } catch {
    return false;
  }
}

function makeShim() {
  const { DatabaseSync } = require('node:sqlite');

  const cast = (value) => {
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value === undefined) return null;
    if (typeof value === 'bigint') return Number(value);
    if (value instanceof Uint8Array) return Buffer.from(value);
    return value;
  };
  const row = (r) => {
    if (!r) return r;
    const out = {};
    for (const [k, v] of Object.entries(r)) out[k] = typeof v === 'bigint' ? Number(v) : v;
    return out;
  };

  class Statement {
    constructor(db, sql) { this.db = db; this.sql = sql; this.st = db.prepare(sql); }
    run(...params) {
      const info = this.st.run(...params.map(cast));
      return { changes: Number(info.changes ?? 0), lastInsertRowid: Number(info.lastInsertRowid ?? 0) };
    }
    get(...params) { return row(this.st.get(...params.map(cast))); }
    all(...params) { return this.st.all(...params.map(cast)).map(row); }
    iterate(...params) { return this.all(...params)[Symbol.iterator](); }
    pluck() { return this; }
  }

  class Database {
    constructor(file) {
      this.db = new DatabaseSync(file === ':memory:' ? ':memory:' : file);
      this.memory = file === ':memory:';
    }
    prepare(sql) { return new Statement(this.db, sql); }
    exec(sql) { this.db.exec(sql); return this; }
    pragma(text) {
      try { this.db.exec(`PRAGMA ${text}`); } catch { /* بعض PRAGMA لا تعمل على الذاكرة */ }
      return undefined;
    }
    transaction(fn) {
      const self = this;
      const wrapped = (...args) => {
        self.db.exec('BEGIN');
        try { const r = fn(...args); self.db.exec('COMMIT'); return r; }
        catch (e) { try { self.db.exec('ROLLBACK'); } catch {} throw e; }
      };
      wrapped.deferred = wrapped; wrapped.immediate = wrapped; wrapped.exclusive = wrapped;
      return wrapped;
    }
    function() { return undefined; }
    close() { try { this.db.close(); } catch {} }
  }
  return Database;
}

let installed = false;
let usingShim = false;

function install() {
  if (installed) return usingShim;
  installed = true;
  if (nativeWorks()) return false;
  const Shim = makeShim();
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'better-sqlite3') return Shim;
    return original.apply(this, arguments);
  };
  usingShim = true;
  return true;
}

module.exports = { install, usingShim: () => usingShim };
