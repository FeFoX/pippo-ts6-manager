import type { PrismaClient } from '../../../generated/prisma/index.js';
import { createWebQueryClient, type WebQueryClient } from '../../ts-client/webquery-client.js';
import { decrypt } from '../../utils/crypto.js';
import { loadBotControlGroups } from '../../utils/app-settings.js';
import type { CommandContext } from './context.js';

/**
 * Who may use the bot's chat commands.
 *
 * The list of server groups (names or ids) is the "Bot access" setting of the web panel.
 * When it holds at least one group, only clients in one of those groups can use the built-in
 * commands. When it is empty everybody can, which is how the app behaves by default.
 *
 * The setting and the sender's groups are read at every command, so a change in the panel or
 * a group taken away in TeamSpeak applies at once. Any failure to find out counts as "not allowed".
 */

export interface ControlGroupSource {
  /** Server group ids the connected client has right now. */
  clientGroups(configId: number, sid: number, clid: number): Promise<number[]>;
  /** The server groups of the virtual server. */
  serverGroups(configId: number, sid: number): Promise<Array<{ id: number; name: string }>>;
}

const GROUP_LIST_TTL_MS = 60_000;
const DENIED_NOTICE_EVERY_MS = 30_000;

export interface AccessDecision {
  /** False when no group is configured: everybody is let in. */
  restricted: boolean;
  allowed: boolean;
  /** The configured groups, for the refusal message. */
  groups: string[];
}

export class ControlAccess {
  private readonly groupIds = new Map<string, { at: number; ids: Set<number> }>();
  private readonly noticeAt = new Map<string, number>();
  private readonly warnedNoMatch = new Set<string>();

  constructor(
    private readonly loadGroups: () => Promise<string[]>,
    private readonly source: ControlGroupSource,
    private readonly now: () => number = Date.now,
  ) {}

  async check(configId: number, sid: number, clid: number): Promise<AccessDecision> {
    let groups: string[];
    try {
      groups = await this.loadGroups();
    } catch (err: any) {
      console.warn(`[MusicCmd] Bot access setting could not be read, denying: ${err?.message || String(err)}`);
      return { restricted: true, allowed: false, groups: [] };
    }
    if (groups.length === 0) return { restricted: false, allowed: true, groups };
    try {
      const [mine, allowed] = await Promise.all([
        this.source.clientGroups(configId, sid, clid),
        this.allowedGroupIds(configId, sid, groups),
      ]);
      return { restricted: true, allowed: mine.some((id) => allowed.has(id)), groups };
    } catch (err: any) {
      console.warn(`[MusicCmd] Control group check failed, denying: ${err?.message || String(err)}`);
      return { restricted: true, allowed: false, groups };
    }
  }

  private async allowedGroupIds(configId: number, sid: number, groups: string[]): Promise<Set<number>> {
    // The group list is part of the key, so editing the setting never reuses an old answer.
    const key = `${configId}:${sid}:${groups.join('\u0000')}`;
    const hit = this.groupIds.get(key);
    if (hit && this.now() - hit.at < GROUP_LIST_TTL_MS) return hit.ids;

    const list = await this.source.serverGroups(configId, sid);
    const ids = new Set<number>();
    for (const entry of groups) {
      const wanted = entry.toLowerCase();
      const numeric = /^\d+$/.test(entry);
      let matched = false;
      for (const group of list) {
        if (numeric ? group.id === Number(entry) : group.name.toLowerCase() === wanted) {
          ids.add(group.id);
          matched = true;
        }
      }
      // A numeric entry is checked against the list too, so a mistyped id is reported
      // like a mistyped name, also when other entries are fine.
      const warnKey = `${key}\u0000${entry}`;
      if (matched) {
        this.warnedNoMatch.delete(warnKey);
      } else if (!this.warnedNoMatch.has(warnKey)) {
        this.warnedNoMatch.add(warnKey);
        console.warn(`[MusicCmd] Bot access group ${JSON.stringify(entry)} matches no server group and is ignored`);
      }
    }
    if (ids.size === 0 && !this.warnedNoMatch.has(key)) {
      this.warnedNoMatch.add(key);
      console.warn(`[MusicCmd] Bot access groups ${JSON.stringify(groups)} match no server group: nobody can use the bot`);
    } else if (ids.size > 0) {
      this.warnedNoMatch.delete(key);
    }
    this.groupIds.set(key, { at: this.now(), ids });
    return ids;
  }

  deniedMessage(groups: string[]): string {
    const names = groups.map((g) => `"${g}"`).join(' or ');
    return `You don't have permission to use the music bot: you need the group ${names}.`;
  }

  /** At most one "not allowed" reply per user every 30 seconds, so a refused user cannot trip TeamSpeak's flood protection. */
  shouldNotifyDenied(configId: number, clid: number): boolean {
    const key = `${configId}:${clid}`;
    const last = this.noticeAt.get(key);
    const now = this.now();
    if (last !== undefined && now - last < DENIED_NOTICE_EVERY_MS) return false;
    this.noticeAt.set(key, now);
    return true;
  }
}

/** Reads the groups through the TeamSpeak Web Query of the bot's server connection. */
class WebQuerySource implements ControlGroupSource {
  private readonly clients = new Map<number, { at: number; client: WebQueryClient }>();

  constructor(private readonly prisma: PrismaClient) {}

  private async client(configId: number): Promise<WebQueryClient> {
    const hit = this.clients.get(configId);
    if (hit && Date.now() - hit.at < GROUP_LIST_TTL_MS) return hit.client;
    const cfg = await this.prisma.tsServerConfig.findUnique({ where: { id: configId } });
    if (!cfg) throw new Error(`server connection ${configId} not found`);
    const client = createWebQueryClient(cfg.host, cfg.webqueryPort, decrypt(cfg.apiKey), cfg.useHttps);
    this.clients.set(configId, { at: Date.now(), client });
    return client;
  }

  async clientGroups(configId: number, sid: number, clid: number): Promise<number[]> {
    const body = await (await this.client(configId)).execute(sid, 'clientinfo', { clid });
    const record = Array.isArray(body) ? body[0] : body;
    return String(record?.client_servergroups ?? '')
      .split(',')
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n));
  }

  async serverGroups(configId: number, sid: number): Promise<Array<{ id: number; name: string }>> {
    const body = await (await this.client(configId)).execute(sid, 'servergrouplist');
    return (Array.isArray(body) ? body : [])
      .map((g: any) => ({ id: parseInt(g.sgid, 10), name: String(g.name ?? '') }))
      .filter((g) => Number.isFinite(g.id));
  }
}

const perContext = new WeakMap<object, ControlAccess>();
let override: ControlAccess | null = null;

/** The access policy for a command handler. Its group list comes from the panel's settings. */
export function controlAccessFor(context: CommandContext): ControlAccess {
  if (override) return override;
  let access = perContext.get(context);
  if (!access) {
    access = new ControlAccess(() => loadBotControlGroups(context.prisma), new WebQuerySource(context.prisma));
    perContext.set(context, access);
  }
  return access;
}

/** Tests only: replace the policy. */
export function setControlAccessForTests(access: ControlAccess | null): void {
  override = access;
}
