/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import {
  loadConversationRecord,
  partListUnionToString,
  type MessageRecord,
} from '@google/gemini-cli-core';
import { getSessionFiles } from '../../utils/sessionUtils.js';
import { MessageType } from '../types.js';
import { INFORMATIVE_TIPS } from '../constants/tips.js';
import {
  CommandKind,
  type CommandContext,
  type SlashCommand,
} from './types.js';

/** Maximum number of recent sessions to analyse. */
const MAX_SESSIONS_TO_ANALYSE = 20;

/** Number of personalised tips to display. */
const TIPS_TO_SHOW = 5;

// ---------------------------------------------------------------------------
// Usage pattern extraction
// ---------------------------------------------------------------------------

interface UsagePatterns {
  /** Slash commands the user has typed (lower-cased, no leading slash). */
  commandsUsed: Set<string>;
  /** Tool names that the AI invoked on behalf of the user. */
  toolsUsed: Set<string>;
  /** Total number of analysed sessions. */
  sessionCount: number;
  /** Total number of user messages across all analysed sessions. */
  userMessageCount: number;
}

/**
 * Extracts slash-commands from a single user message string.
 * Returns an empty array if the message is not a command.
 */
function extractSlashCommands(content: string): string[] {
  const trimmed = content.trim();
  if (!trimmed.startsWith('/')) return [];
  // Take the first token (command name) and any immediate sub-command token.
  const parts = trimmed.replace(/^\//, '').split(/\s+/);
  const results: string[] = [parts[0]];
  if (parts[1] && !parts[1].startsWith('-') && !parts[1].includes('/')) {
    results.push(`${parts[0]} ${parts[1]}`);
  }
  return results.map((c) => c.toLowerCase());
}

/**
 * Analyses a single MessageRecord and updates the UsagePatterns in place.
 */
function processMessage(msg: MessageRecord, patterns: UsagePatterns): void {
  if (msg.type === 'user') {
    patterns.userMessageCount++;
    const content = partListUnionToString(msg.content);
    for (const cmd of extractSlashCommands(content)) {
      patterns.commandsUsed.add(cmd);
    }
  } else if (msg.type === 'gemini' && msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      patterns.toolsUsed.add(tc.name);
    }
  }
}

/**
 * Loads recent sessions and aggregates usage patterns.
 */
async function buildUsagePatterns(
  chatsDir: string,
  currentSessionId: string | undefined,
): Promise<UsagePatterns> {
  const patterns: UsagePatterns = {
    commandsUsed: new Set(),
    toolsUsed: new Set(),
    sessionCount: 0,
    userMessageCount: 0,
  };

  const sessions = await getSessionFiles(chatsDir, currentSessionId);
  // Most recent first.
  const recent = [...sessions]
    .sort(
      (a, b) =>
        new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime(),
    )
    .slice(0, MAX_SESSIONS_TO_ANALYSE);

  for (const session of recent) {
    const filePath = path.join(chatsDir, session.fileName);
    try {
      const record = await loadConversationRecord(filePath);
      if (!record) continue;
      patterns.sessionCount++;
      for (const msg of record.messages) {
        processMessage(msg, patterns);
      }
    } catch {
      // Skip unreadable sessions.
    }
  }

  return patterns;
}

// ---------------------------------------------------------------------------
// Tip scoring / personalisation
// ---------------------------------------------------------------------------

/**
 * Each entry maps a category label to:
 *  - `featureUsed`: condition that returns true when the user already uses this feature
 *  - `tipMatches`: substrings to look for in INFORMATIVE_TIPS to select related tips
 */
interface TipCategory {
  featureUsed: (p: UsagePatterns) => boolean;
  tipMatches: string[];
}

const TIP_CATEGORIES: TipCategory[] = [
  // Suggest /resume when the user has never used it.
  {
    featureUsed: (p) => p.commandsUsed.has('resume'),
    tipMatches: ['/resume', 'checkpoint', 'conversation'],
  },
  // Suggest /compress when the user never compressed.
  {
    featureUsed: (p) => p.commandsUsed.has('compress'),
    tipMatches: ['/compress', 'compress', 'summariz'],
  },
  // Suggest /memory if never used.
  {
    featureUsed: (p) =>
      p.commandsUsed.has('memory') || p.commandsUsed.has('memory show'),
    tipMatches: ['/memory', 'memory'],
  },
  // Suggest /stats if never used.
  {
    featureUsed: (p) => p.commandsUsed.has('stats'),
    tipMatches: ['/stats', 'usage stats', 'statistics'],
  },
  // Suggest editor shortcut when user has many messages but never used /editor.
  {
    featureUsed: (p) => p.commandsUsed.has('editor') || p.userMessageCount < 20,
    tipMatches: ['external editor', 'Ctrl+G', '/editor'],
  },
  // Suggest YOLO mode when tools are used frequently but mode wasn't toggled.
  {
    featureUsed: (p) => p.commandsUsed.has('yolo') || p.toolsUsed.size < 3,
    tipMatches: ['YOLO', 'auto-approval', 'Ctrl+Y'],
  },
  // Suggest /theme when never used.
  {
    featureUsed: (p) => p.commandsUsed.has('theme'),
    tipMatches: ['/theme', 'color theme', 'custom themes'],
  },
  // Suggest /tools listing when user has never run it.
  {
    featureUsed: (p) => p.commandsUsed.has('tools'),
    tipMatches: ['/tools', 'available tools'],
  },
  // Suggest vim mode when never enabled.
  {
    featureUsed: (p) => p.commandsUsed.has('vim'),
    tipMatches: ['/vim', 'Vim mode', 'Vim keybindings'],
  },
  // Suggest copy command.
  {
    featureUsed: (p) => p.commandsUsed.has('copy'),
    tipMatches: ['/copy', 'clipboard'],
  },
  // Suggest MCP tips for power users who use many tools.
  {
    featureUsed: (p) => p.commandsUsed.has('mcp') || p.toolsUsed.size < 5,
    tipMatches: ['/mcp', 'MCP'],
  },
  // Suggest keyboard shortcuts overview.
  {
    featureUsed: (p) => p.commandsUsed.has('shortcuts'),
    tipMatches: ['Ctrl+R', 'Ctrl+A', 'Ctrl+E', 'Alt+M'],
  },
  // Suggest /restore for version-control users.
  {
    featureUsed: (p) => p.commandsUsed.has('restore'),
    tipMatches: ['/restore', 'Restore project'],
  },
  // Suggest /init if user hasn't set up project context.
  {
    featureUsed: (p) => p.commandsUsed.has('init'),
    tipMatches: ['/init', 'GEMINI.md'],
  },
  // Suggest /directory usage.
  {
    featureUsed: (p) =>
      p.commandsUsed.has('directory') || p.commandsUsed.has('dir'),
    tipMatches: ['/directory', '/dir', 'workspace'],
  },
];

/**
 * Selects tips from INFORMATIVE_TIPS that are relevant to unused features.
 * Returns at most `count` tips.
 */
function selectPersonalisedTips(
  patterns: UsagePatterns,
  count: number,
): string[] {
  const selected: string[] = [];
  const usedTipIndices = new Set<number>();

  for (const category of TIP_CATEGORIES) {
    if (selected.length >= count) break;
    // Only recommend tips for features the user has NOT used.
    if (category.featureUsed(patterns)) continue;

    for (const tipText of INFORMATIVE_TIPS) {
      if (selected.length >= count) break;
      const idx = INFORMATIVE_TIPS.indexOf(tipText);
      if (usedTipIndices.has(idx)) continue;
      const lower = tipText.toLowerCase();
      const matches = category.tipMatches.some((m) =>
        lower.includes(m.toLowerCase()),
      );
      if (matches) {
        selected.push(tipText);
        usedTipIndices.add(idx);
      }
    }
  }

  // If we still have room, fill with random tips that weren't already chosen.
  if (selected.length < count) {
    const remaining = INFORMATIVE_TIPS.filter((_, i) => !usedTipIndices.has(i));
    // Shuffle deterministically enough for UX purposes.
    const shuffled = remaining.sort(() => Math.random() - 0.5);
    for (const tip of shuffled) {
      if (selected.length >= count) break;
      selected.push(tip);
    }
  }

  return selected;
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

const tipsSubCommand: SlashCommand = {
  name: 'tips',
  description:
    'Analyse your session history and recommend personalised tips based on your usage patterns',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  isSafeConcurrent: true,
  action: async (context: CommandContext): Promise<void> => {
    const config = context.services.agentContext?.config;

    if (!config) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: 'Chronicle tips: configuration not available.',
        },
        Date.now(),
      );
      return;
    }

    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: 'Analysing your session history…',
      },
      Date.now(),
    );

    const chatsDir = path.join(config.storage.getProjectTempDir(), 'chats');
    const currentSessionId = config.getSessionId();

    let patterns: UsagePatterns;
    try {
      patterns = await buildUsagePatterns(chatsDir, currentSessionId);
    } catch (err) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: `Chronicle tips: failed to read session history – ${err instanceof Error ? err.message : String(err)}`,
        },
        Date.now(),
      );
      return;
    }

    const tips = selectPersonalisedTips(patterns, TIPS_TO_SHOW);

    if (tips.length === 0) {
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: "You're already using all the features we know about – great work!",
        },
        Date.now(),
      );
      return;
    }

    const sessionSummary =
      patterns.sessionCount === 0
        ? 'No previous sessions found – showing general tips.'
        : `Based on ${patterns.sessionCount} session${patterns.sessionCount === 1 ? '' : 's'} and ${patterns.userMessageCount} user message${patterns.userMessageCount === 1 ? '' : 's'}:`;

    const tipLines = tips.map((tip, i) => `  ${i + 1}. ${tip}`).join('\n');

    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: `✨ Personalised tips for you\n\n${sessionSummary}\n\n${tipLines}`,
      },
      Date.now(),
    );
  },
};

export const chronicleCommand: SlashCommand = {
  name: 'chronicle',
  description: 'Review your session history and discover personalised tips',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  isSafeConcurrent: true,
  subCommands: [tipsSubCommand],
};
