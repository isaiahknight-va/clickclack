import type { ReactionSummary, ReactionUser } from "./types";

/** Mirrors store.ReactionUserLimit on the server. */
export const REACTION_USER_LIMIT = 8;

// House convention (TYP): agents acknowledge an instruction with the eyes
// reaction, so this one emoji answers "who saw this" rather than "who liked
// this". The server treats it as an ordinary reaction; only the client separates
// it.
export const SEEN_EMOJI = "👀";

export function isSeenReaction(reaction: Pick<ReactionSummary, "emoji">): boolean {
  return reaction.emoji === SEEN_EMOJI;
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
