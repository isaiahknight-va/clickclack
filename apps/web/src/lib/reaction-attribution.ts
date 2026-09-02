import type { ReactionSummary, ReactionUser } from "./types";

/** Mirrors store.ReactionUserLimit on the server. */
export const REACTION_USER_LIMIT = 8;

// House convention (TYP): agents acknowledge an instruction with the eyes
// reaction, so this one emoji answers "who saw this" rather than "who liked
// this". The server treats it as an ordinary reaction; only the client separates
// it.
export const SEEN_EMOJI = "👀";

// The server stores whatever string the writer sent, so the same acknowledgement
// arrives in more than one spelling: the picker writes the glyph, the TYP bridge
// posts the literal shortcode "eyes", and some clients pad the glyph with VS16.
// Order is the display order of the merged membership, not chronology, because
// the payload carries no reaction timestamps to interleave the variants by.
export const SEEN_EMOJI_FORMS: readonly string[] = [SEEN_EMOJI, `${SEEN_EMOJI}\uFE0F`, "eyes"];

export function isSeenReaction(reaction: Pick<ReactionSummary, "emoji">): boolean {
  return SEEN_EMOJI_FORMS.includes(reaction.emoji);
}

/**
 * Collapses every seen-variant reaction on a message into one pill entry that
 * reports the glyph, the summed tally, and the concatenated membership. Chips
 * that are not a seen variant pass through untouched, still carrying whatever
 * string the server stored.
 */
export function mergeSeenReactions(reactions: ReactionSummary[]): ReactionSummary[] {
  const variants = SEEN_EMOJI_FORMS.flatMap((form) =>
    reactions.filter((reaction) => reaction.emoji === form),
  );
  if (variants.length === 0) return [...reactions];

  const users: ReactionUser[] = [];
  const named = new Set<string>();
  let count = 0;
  let reactedByMe = false;
  for (const variant of variants) {
    count += Math.max(0, Math.floor(variant.count));
    reactedByMe ||= variant.reacted_by_me;
    for (const user of variant.users ?? []) {
      if (!user?.id) continue;
      if (named.has(user.id)) {
        // One person holding two spellings still saw the message once, so the
        // collapsed membership leaves the headcount rather than inflating it.
        // Only named duplicates are detectable; unnamed ones stay counted twice.
        count -= 1;
        continue;
      }
      named.add(user.id);
      users.push(user);
    }
  }

  return [
    {
      emoji: SEEN_EMOJI,
      count: Math.max(count, users.length),
      reacted_by_me: reactedByMe,
      users,
    },
    ...reactions.filter((reaction) => !isSeenReaction(reaction)),
  ];
}

// The server names only the earliest reactors (see ReactionSummary.users), so
// every label here is built from the named subset plus the authoritative count.
// Anything the client cannot name stays counted rather than guessed.

export function reactorNames(reaction: ReactionSummary, currentUserID: string): string[] {
  const names: string[] = [];
  for (const user of reaction.users ?? []) {
    if (!user?.id) continue;
    const name = user.id === currentUserID ? "You" : user.display_name.trim();
    if (name) names.push(name);
  }
  return names;
}

export function unnamedReactorCount(reaction: ReactionSummary, namedCount: number): number {
  return Math.max(0, Math.floor(reaction.count) - namedCount);
}

function joinNames(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function peopleLabel(count: number): string {
  return count === 1 ? "1 person" : `${count} people`;
}

function othersLabel(count: number): string {
  return count === 1 ? "1 other" : `${count} others`;
}

/** Who reacted, as a sentence: "You, Ada, and 2 others reacted with 👍". */
export function reactionAttributionText(reaction: ReactionSummary, currentUserID: string): string {
  const names = reactorNames(reaction, currentUserID);
  const unnamed = unnamedReactorCount(reaction, names.length);
  if (names.length === 0) {
    const total = Math.max(1, Math.floor(reaction.count));
    return `${peopleLabel(total)} reacted with ${reaction.emoji}`;
  }
  const parts = unnamed > 0 ? [...names, othersLabel(unnamed)] : names;
  return `${joinNames(parts)} reacted with ${reaction.emoji}`;
}

/** Who saw a message: "Seen by You, Ada, and 2 others". */
export function seenAttributionText(reaction: ReactionSummary, currentUserID: string): string {
  const names = reactorNames(reaction, currentUserID);
  const unnamed = unnamedReactorCount(reaction, names.length);
  if (names.length === 0) {
    return `Seen by ${peopleLabel(Math.max(1, Math.floor(reaction.count)))}`;
  }
  const parts = unnamed > 0 ? [...names, othersLabel(unnamed)] : names;
  return `Seen by ${joinNames(parts)}`;
}

/** Screen-reader label for the seen pill: who saw it, and what the button does. */
export function seenAriaLabel(reaction: ReactionSummary, currentUserID: string): string {
  return `${seenAttributionText(reaction, currentUserID)}. Show who saw this message`;
}

/** Screen-reader label for a chip: state, tally, and who. */
export function reactionAriaLabel(reaction: ReactionSummary, currentUserID: string): string {
  const count = Math.max(1, Math.floor(reaction.count));
  const plural = count === 1 ? "reaction" : "reactions";
  return `${reaction.emoji}, ${count} ${plural}. ${reactionAttributionText(reaction, currentUserID)}`;
}

/** Adds a reactor to a named list without exceeding what the server would send. */
export function withReactor(
  users: ReactionUser[] | undefined,
  reactor: ReactionUser | undefined,
  limit: number,
): ReactionUser[] {
  const next = [...(users ?? [])];
  if (!reactor?.id) return next;
  if (next.some((user) => user.id === reactor.id)) return next;
  if (next.length >= limit) return next;
  next.push(reactor);
  return next;
}

/** Drops a reactor by id, used when an event says they took their reaction back. */
export function withoutReactor(users: ReactionUser[] | undefined, userID: string): ReactionUser[] {
  return (users ?? []).filter((user) => user.id !== userID);
}
