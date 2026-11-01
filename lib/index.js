/**
 * dsh-fs-reobserve: the middle ground between the two extremes.
 *
 * THE GAP
 * -------
 * @deepseek-ai/dsh-fs-observation-policy records a file's version only from
 * INSTRUMENTED filesystem operations: the read, write and edit tools emit
 * 'fs/observed'. bash, shell and subprocess emit nothing; dsh-tool-bash,
 * dsh-shell and dsh-subprocess-local contain no reference to the event at all.
 * DSH documents this: "Only instrumented filesystem operations report here;
 * the OS is not watched."
 *
 * So a session that modifies a file through bash leaves a STALE observation
 * behind, and its very next edit of that file is refused with
 * FS_STALE_VERSION, an error caused entirely by the session's own action.
 *
 * WHAT THIS DOES
 * --------------
 * After one of this session's own bash/shell calls settles, re-stat the files
 * THAT SESSION had observed and re-emit 'fs/observed' at their current state.
 * All three transitions are covered:
 *
 *   present -> present (new version)  the command rewrote the file
 *   present -> absent                 the command deleted the file
 *   absent  -> present                the command created a file that a read
 *                                     had previously confirmed missing
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It never re-observes a change the session did not cause. A file rewritten by
 * cron, by another agent, or by an editor on the desktop keeps its old
 * observation, so the next edit still fails with FS_STALE_VERSION and the agent
 * is still forced to re-read. That is the protection worth keeping, and this
 * plugin preserves it exactly.
 *
 * Net effect: the guard fires on THIRD-PARTY changes (where it matters) and
 * stays quiet on SELF-INFLICTED ones (where it was only ever friction).
 *
 * A version is never manufactured: it is read from ctx.fs.stat, which is the
 * only sanctioned source (see dsh-fs: "a consumer never manufactures a version,
 * it receives one from stat/write/edit outcomes").
 *
 * WHY THERE ARE NO STATIC @deepseek-ai/* IMPORTS
 * ---------------------------------------------
 * Same reason as other out-of-tree DSH plugins: those packages
 * drift between releases, and a plugin living OUTSIDE the profile's
 * node_modules tree cannot resolve them at all (this plugin is a `link:`
 * dependency, so Node resolves its realpath and finds no @deepseek-ai above
 * it). A static import would therefore make the whole plugin fail to load.
 * The one package we want (dsh-llm, for the canonical createUserMessage) is
 * resolved lazily at runtime with several candidate roots, and the plugin
 * degrades to logging-only if it cannot be found. Nothing here can prevent the
 * plugin from loading.
 *
 * @module dsh-fs-reobserve
 */
import { createRequire } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'fs-reobserve';

/** We need the filesystem service to re-stat observed targets. */
export const inject = ['fs'];

/** Tools whose side effects bypass the instrumented fs path. */
const DEFAULT_TOOLS = ['bash', 'shell'];

/** Provenance stamped on the notice we attach to the tool result. */
const PLUGIN_SOURCE = { kind: 'plugin:fs-reobserve' };  // v4 producer kind; the retired { kind: 'plugin', plugin } shape is refused by DSH 0.2.x

/**
 * Resolve the host's own dsh-llm, or null when it cannot be found. Tries, in
 * order: normal resolution (a vendored/installed plugin), the profile tree,
 * then the running DSH install derived from the dsh binary's real path.
 * @returns the dsh-llm module namespace, or null.
 */
function loadDshLlm() {
  const attempt = (base) => {
    try {
      return createRequire(base)('@deepseek-ai/dsh-llm');
    } catch {
      return null;
    }
  };

  const direct = attempt(import.meta.url);
  if (direct !== null) return direct;

  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const fromProfile = attempt(join(dshHome, 'profiles', 'web', 'package.json'));
  if (fromProfile !== null) return fromProfile;

  const roots = [];
  try {
    const real = realpathSync(process.argv[1]);
    const at = real.indexOf('@deepseek-ai');
    if (at > 0) roots.push(real.slice(0, at)); // <prefix>/lib/node_modules/
  } catch {
    // argv[1] may be missing or unresolvable; the env/fallback roots still apply.
  }
  if (process.env.DSH_GLOBAL_PREFIX) roots.push(join(process.env.DSH_GLOBAL_PREFIX, 'lib', 'node_modules'));
  roots.push(join(homedir(), '.local', 'lib', 'node_modules'));

  for (const root of roots) {
    const found = attempt(join(root, '@deepseek-ai', 'dsh', 'package.json'));
    if (found !== null) return found;
  }
  return null;
}

const dshLlm = loadDshLlm();

/**
 * Build the model-facing notice. Uses the host's createUserMessage when it is
 * resolvable, and otherwise reproduces its exact output shape
 * (`{...input, id, role:'user'}`, frozen) so the notice still lands.
 * @returns a frozen user message.
 */
function makeNotice(text, summary) {
  const input = {
    content: [{ type: 'text', text }],
    source: { ...PLUGIN_SOURCE, form: 'notice', summary }
  };
  if (dshLlm?.createUserMessage !== undefined) {
    try {
      return dshLlm.createUserMessage(input);
    } catch {
      // Fall through to the local construction rather than lose the notice.
    }
  }
  return Object.freeze({
    ...input,
    id: randomUUID(),
    role: 'user',
    content: Object.freeze(input.content),
    source: Object.freeze(input.source)
  });
}

/**
 * Install the re-observation listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - optional config; every field falls back to its default.
 */
export function apply(ctx, config = {}) {
  const tools = new Set(Array.isArray(config.tools) && config.tools.length > 0 ? config.tools : DEFAULT_TOOLS);
  const notify = config.notify !== false;
  const maxNotifyPaths = Number.isInteger(config.maxNotifyPaths) && config.maxNotifyPaths > 0 ? config.maxNotifyPaths : 4;

  /**
   * Per-owner (session) map of targetKey -> { target, observation }. Weakly
   * held so a collected session frees its bookkeeping. We learn these by
   * listening to the same 'fs/observed' broadcast the policy does; the
   * policy's own map is private, and this avoids reaching into it.
   */
  const observedByOwner = new WeakMap();

  /** Derive the observed-state owner exactly as the policy does. */
  const ownerOf = (actor) => actor?.agent?.session;

  // Boot line. Without it, a plugin that silently failed to load looks exactly
  // like one that loaded and found nothing to do. Grep the dsh-web journal for
  // this line first when re-observation is not happening:
  //   journalctl -u dsh-web.service | grep fs-reobserve
  ctx.logger.info(
    'fs-reobserve: armed -- reacting to [%s], notify=%s, maxNotifyPaths=%d',
    [...tools].join(', '), String(notify), maxNotifyPaths
  );

  ctx.on('fs/observed', (target, observation, actor) => {
    const owner = ownerOf(actor);
    if (owner === undefined) return;
    let byTarget = observedByOwner.get(owner);
    if (byTarget === undefined) {
      byTarget = new Map();
      observedByOwner.set(owner, byTarget);
    }
    byTarget.set(target.targetKey, { target, observation });
  });

  ctx.on('tools/post-execute', async (exec, _result, next) => {
    // Let the tool settle first; we only refresh after it has finished.
    const downstream = await next();

    if (tools.has(exec?.name) !== true) return downstream;

    const owner = ownerOf(exec);
    if (owner === undefined) return downstream;
    const byTarget = observedByOwner.get(owner);
    if (byTarget === undefined || byTarget.size === 0) return downstream;

    // stat() takes an OPTIONAL signal. Once the tool has settled the call
    // signal may already be aborted, and passing an aborted signal would make
    // every stat throw, so drop it rather than lose the refresh.
    const signal = exec.signal?.aborted === true ? undefined : exec.signal;

    const changed = [];
    const removed = [];
    const created = [];

    for (const entry of byTarget.values()) {
      const { target, observation } = entry;
      const wasPresent = observation?.kind === 'present';

      let info;
      try {
        info = await ctx.fs.stat(target, signal);
      } catch {
        // Unreadable or vanished mid-stat: leave the prior observation alone.
        continue;
      }

      const isFile = info !== undefined && info.type === 'file';

      if (isFile && wasPresent) {
        if (info.version === observation.version) continue; // untouched
        entry.observation = { kind: 'present', version: info.version };
        ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
        changed.push(target.displayPath);
        continue;
      }

      if (!isFile && wasPresent) {
        entry.observation = { kind: 'absent' };
        ctx.emit('fs/observed', target, { kind: 'absent' }, exec);
        removed.push(target.displayPath);
        continue;
      }

      if (isFile && !wasPresent) {
        entry.observation = { kind: 'present', version: info.version };
        ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
        created.push(target.displayPath);
      }
    }

    const total = changed.length + removed.length + created.length;
    if (total === 0) return downstream;

    // info, not debug: this is the one line a human needs when a turn behaves
    // unexpectedly after a bash command, and it fires only when something
    // actually changed.
    ctx.logger.info(
      'fs-reobserve: refreshed %d observation(s) after %s (changed=%d removed=%d created=%d)',
      total, exec.name, changed.length, removed.length, created.length
    );

    if (!notify) return downstream;

    let notice;
    try {
      notice = makeNotice(describe(exec.name, changed, removed, created, maxNotifyPaths), 'refreshed ' + total + ' file(s)');
    } catch {
      return downstream; // never let the notice break a successful tool result
    }

    return {
      ...downstream,
      additionalContexts: [notice, ...(downstream.additionalContexts ?? [])]
    };
  });
}

/**
 * Render the model-facing notice. It states the one thing the agent cannot
 * infer: that the observation was refreshed, so an edit will now be accepted,
 * and that this says nothing about who else may have written the file.
 * @returns the notice text.
 */
function describe(toolName, changed, removed, created, maxNotifyPaths) {
  const list = (paths) => {
    const shown = paths.slice(0, maxNotifyPaths);
    const extra = paths.length - shown.length;
    return shown.join(', ') + (extra > 0 ? ' (+' + extra + ' more)' : '');
  };
  const parts = [];
  if (changed.length > 0) parts.push('rewrote ' + changed.length + ': ' + list(changed));
  if (removed.length > 0) parts.push('deleted ' + removed.length + ': ' + list(removed));
  if (created.length > 0) parts.push('created ' + created.length + ': ' + list(created));

  return 'fs-reobserve refreshed stale file observations after your ' + toolName +
    ' command (' + parts.join('; ') + '). ' +
    'These files changed as a side effect of your OWN command, so a following edit or write of them ' +
    'will be accepted without a fresh read. Their content DID change: re-read a file if you need its ' +
    'current text. Changes made by anything other than your own command are deliberately NOT refreshed, ' +
    'so a stale-version error still means someone or something else wrote the file.';
}

/**
 * Match dsh-mail's entry shape: a default OBJECT, never the bare function.
 *
 * This is not cosmetic. If the loader prefers the module's default export,
 * `export default apply` hands it a function whose `.apply` property is
 * `Function.prototype.apply`. The loader's `plugin.apply(ctx, config)` then
 * invokes Function.prototype.apply with ctx as `this` and no argument array,
 * so the real apply runs with both parameters undefined, throws on the first
 * `ctx.logger.info`, and the plugin disappears with NO boot log and NO error
 * in the journal -- exactly the silent failure this plugin showed.
 * dsh-hpc gets away with named exports only; dsh-mail exports this object.
 * This does both.
 */
export default { name, apply, inject };
