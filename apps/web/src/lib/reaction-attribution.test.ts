import test from "node:test";
import assert from "node:assert/strict";
import {
  isSeenReaction,
  REACTION_USER_LIMIT,
  reactionAriaLabel,
  reactionAttributionText,
  reactorNames,
  SEEN_EMOJI,
  seenAriaLabel,
  seenAttributionText,
  unnamedReactorCount,
  withReactor,
  withoutReactor,
} from "./reaction-attribution.ts";
import type { ReactionSummary, ReactionUser } from "./types";

const user = (id: string, name: string): ReactionUser => ({ id, display_name: name });

const summary = (count: number, users: ReactionUser[]): ReactionSummary => ({
  emoji: "👀",
  count,
  reacted_by_me: false,
  users,
});

test("reactorNames renders the viewer as You and keeps server order", () => {
  const reaction = summary(3, [user("u1", "Ada"), user("u2", "Bo"), user("u3", "Cy")]);
  assert.deepEqual(reactorNames(reaction, "u2"), ["Ada", "You", "Cy"]);
});

test("reactorNames skips blank identities", () => {
  const reaction = summary(2, [
    { id: "", display_name: "Ghost" },
    { id: "u2", display_name: "   " },
    user("u3", "Cy"),
  ]);
  assert.deepEqual(reactorNames(reaction, ""), ["Cy"]);
});

test("attribution names one, two, and three reactors", () => {
  assert.equal(reactionAttributionText(summary(1, [user("u1", "Ada")]), ""), "Ada reacted with 👀");
  assert.equal(
    reactionAttributionText(summary(2, [user("u1", "Ada"), user("u2", "Bo")]), ""),
    "Ada and Bo reacted with 👀",
  );
  assert.equal(
    reactionAttributionText(
      summary(3, [user("u1", "Ada"), user("u2", "Bo"), user("u3", "Cy")]),
      "",
    ),
    "Ada, Bo, and Cy reacted with 👀",
  );
});

test("attribution reports unnamed reactors from the authoritative count", () => {
  const reaction = summary(12, [user("u1", "Ada"), user("u2", "Bo")]);
  assert.equal(unnamedReactorCount(reaction, 2), 10);
  assert.equal(reactionAttributionText(reaction, ""), "Ada, Bo, and 10 others reacted with 👀");
  assert.equal(
    reactionAttributionText(summary(3, [user("u1", "Ada"), user("u2", "Bo")]), "u1"),
    "You, Bo, and 1 other reacted with 👀",
  );
});

test("attribution falls back to a headcount when nobody is named", () => {
  assert.equal(reactionAttributionText(summary(1, []), ""), "1 person reacted with 👀");
  assert.equal(reactionAttributionText(summary(4, []), ""), "4 people reacted with 👀");
  assert.equal(
    reactionAttributionText(summary(2, undefined as never), ""),
    "2 people reacted with 👀",
  );
});

test("aria label carries state, tally, and attribution", () => {
  assert.equal(
    reactionAriaLabel(summary(2, [user("u1", "Ada"), user("u2", "Bo")]), "u2"),
    "👀, 2 reactions. Ada and You reacted with 👀",
  );
  assert.equal(
    reactionAriaLabel(summary(1, [user("u1", "Ada")]), ""),
    "👀, 1 reaction. Ada reacted with 👀",
  );
});

test("only the eyes reaction reads as a seen receipt", () => {
  assert.equal(SEEN_EMOJI, "👀");
  assert.equal(isSeenReaction({ emoji: SEEN_EMOJI }), true);
  assert.equal(isSeenReaction({ emoji: "👍" }), false);
  assert.equal(isSeenReaction({ emoji: "" }), false);
});

test("seen attribution names viewers instead of reactors", () => {
  assert.equal(seenAttributionText(summary(1, [user("u1", "Tater")]), ""), "Seen by Tater");
  assert.equal(
    seenAttributionText(summary(2, [user("u1", "Tater"), user("u2", "Isaiah Knight")]), ""),
    "Seen by Tater and Isaiah Knight",
  );
  assert.equal(
    seenAttributionText(summary(3, [user("u1", "Tater"), user("u2", "Bo")]), "u2"),
    "Seen by Tater, You, and 1 other",
  );
});

test("seen attribution falls back to a headcount and stays bounded", () => {
  assert.equal(seenAttributionText(summary(1, []), ""), "Seen by 1 person");
  assert.equal(seenAttributionText(summary(5, []), ""), "Seen by 5 people");
  assert.equal(
    seenAttributionText(summary(12, [user("u1", "Ada"), user("u2", "Bo")]), ""),
    "Seen by Ada, Bo, and 10 others",
  );
});

test("seen aria label names the viewers and what the pill does", () => {
  assert.equal(
    seenAriaLabel(summary(2, [user("u1", "Tater"), user("u2", "Isaiah Knight")]), ""),
    "Seen by Tater and Isaiah Knight. Show who saw this message",
  );
  // The pill is not a toggle, so its label never claims a reaction tally.
  assert.doesNotMatch(seenAriaLabel(summary(2, []), ""), /reaction/);
});

test("withReactor appends once and respects the server bound", () => {
  const ada = user("u1", "Ada");
  assert.deepEqual(withReactor([], ada, REACTION_USER_LIMIT), [ada]);
  assert.deepEqual(withReactor([ada], ada, REACTION_USER_LIMIT), [ada]);
  assert.deepEqual(withReactor(undefined, undefined, REACTION_USER_LIMIT), []);

  const full = Array.from({ length: REACTION_USER_LIMIT }, (_, i) => user(`u${i}`, `N${i}`));
  assert.equal(
    withReactor(full, user("late", "Late"), REACTION_USER_LIMIT).length,
    REACTION_USER_LIMIT,
  );
});

test("withoutReactor drops the named reactor only", () => {
  const users = [user("u1", "Ada"), user("u2", "Bo")];
  assert.deepEqual(withoutReactor(users, "u1"), [user("u2", "Bo")]);
  assert.deepEqual(withoutReactor(users, "nobody"), users);
  assert.deepEqual(withoutReactor(undefined, "u1"), []);
});

test("a removal by another user keeps the count and the remaining names honest", () => {
  // Mirrors the realtime path: the event names its actor, so the client drops
  // that name and trusts the server count for everyone it cannot name.
  const users = withoutReactor([user("u1", "Ada"), user("u2", "Bo")], "u2");
  const reaction: ReactionSummary = { emoji: "👀", count: 5, reacted_by_me: false, users };
  assert.equal(reactionAttributionText(reaction, ""), "Ada and 4 others reacted with 👀");
});
