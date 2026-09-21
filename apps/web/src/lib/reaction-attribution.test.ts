import test from "node:test";
import assert from "node:assert/strict";
import {
  isSeenReaction,
  mergeSeenReactions,
  REACTION_USER_LIMIT,
  reactionAriaLabel,
  reactionAttributionText,
  reactorNames,
  SEEN_EMOJI,
  SEEN_EMOJI_FORMS,
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

test("every spelling the server stores verbatim reads as the same receipt", () => {
  // The picker writes the glyph; the TYP bridge posts the literal shortcode.
  // Both land in the store unvalidated, so both have to answer "who saw this".
  assert.equal(isSeenReaction({ emoji: "eyes" }), true);
  assert.equal(isSeenReaction({ emoji: "\u{1F440}" }), true);
  assert.equal(isSeenReaction({ emoji: "\u{1F440}\uFE0F" }), true);
  assert.deepEqual([...SEEN_EMOJI_FORMS], ["\u{1F440}", "\u{1F440}\uFE0F", "eyes"]);
  // Near misses stay ordinary chips rather than silently joining the pill.
  for (const emoji of [":eyes:", "Eyes", "eye", "eyes ", "👁"]) {
    assert.equal(isSeenReaction({ emoji }), false, emoji);
  }
});

test("merge leaves a message without any seen variant alone", () => {
  const reactions: ReactionSummary[] = [
    { emoji: "👍", count: 2, reacted_by_me: false, users: [user("u1", "Ada")] },
  ];
  const merged = mergeSeenReactions(reactions);
  assert.deepEqual(merged, reactions);
  assert.notEqual(merged, reactions, "callers sort the result, so it must be a fresh array");
});

test("merge collapses the variants into one pill and passes other chips through", () => {
  const merged = mergeSeenReactions([
    { emoji: "👍", count: 3, reacted_by_me: false, users: [user("u9", "Zed")] },
    { emoji: "eyes", count: 2, reacted_by_me: false, users: [user("b1", "Reader bot")] },
    { emoji: SEEN_EMOJI, count: 1, reacted_by_me: true, users: [user("u1", "Ada")] },
  ]);
  assert.equal(merged.length, 2);
  const [pill, thumbs] = merged;
  // The pill renders the glyph even when the membership arrived as a string.
  assert.equal(pill.emoji, SEEN_EMOJI);
  assert.equal(pill.count, 3);
  assert.equal(pill.reacted_by_me, true);
  assert.deepEqual(pill.users, [user("u1", "Ada"), user("b1", "Reader bot")]);
  // Ordinary chips keep whatever the server stored, untouched.
  assert.deepEqual(thumbs, {
    emoji: "👍",
    count: 3,
    reacted_by_me: false,
    users: [user("u9", "Zed")],
  });
});

test("merge orders membership by variant, earliest reactors first inside each", () => {
  const merged = mergeSeenReactions([
    {
      emoji: "eyes",
      count: 2,
      reacted_by_me: false,
      users: [user("b1", "Bot"), user("b2", "Bot two")],
    },
    { emoji: "\u{1F440}\uFE0F", count: 1, reacted_by_me: false, users: [user("v1", "Vee")] },
    {
      emoji: SEEN_EMOJI,
      count: 2,
      reacted_by_me: false,
      users: [user("u1", "Ada"), user("u2", "Bo")],
    },
  ]);
  assert.deepEqual(
    merged[0].users?.map((u) => u.id),
    ["u1", "u2", "v1", "b1", "b2"],
  );
  // Input order does not steer the result: the form list does.
  const reversed = mergeSeenReactions([
    {
      emoji: SEEN_EMOJI,
      count: 2,
      reacted_by_me: false,
      users: [user("u1", "Ada"), user("u2", "Bo")],
    },
    { emoji: "\u{1F440}\uFE0F", count: 1, reacted_by_me: false, users: [user("v1", "Vee")] },
    {
      emoji: "eyes",
      count: 2,
      reacted_by_me: false,
      users: [user("b1", "Bot"), user("b2", "Bot two")],
    },
  ]);
  assert.deepEqual(merged[0].users, reversed[0].users);
});

test("merge keeps the and-N-others math honest against the summed counts", () => {
  // Each variant is bounded at REACTION_USER_LIMIT, so the merged pill names
  // what it can and lets the summed count report the rest.
  const merged = mergeSeenReactions([
    { emoji: SEEN_EMOJI, count: 9, reacted_by_me: false, users: [user("u1", "Ada")] },
    { emoji: "eyes", count: 4, reacted_by_me: false, users: [user("b1", "Reader bot")] },
  ]);
  const pill = merged[0];
  assert.equal(pill.count, 13);
  assert.equal(unnamedReactorCount(pill, 2), 11);
  assert.equal(seenAttributionText(pill, ""), "Seen by Ada, Reader bot, and 11 others");
  assert.equal(seenAttributionText(pill, "b1"), "Seen by Ada, You, and 11 others");
});

test("merge counts a reactor holding two spellings as one viewer", () => {
  // Dedupe and a summed count only agree if the collapsed membership also
  // leaves the tally, otherwise one person becomes "and 1 other".
  const merged = mergeSeenReactions([
    { emoji: SEEN_EMOJI, count: 1, reacted_by_me: false, users: [user("u1", "Tater")] },
    { emoji: "eyes", count: 1, reacted_by_me: false, users: [user("u1", "Tater")] },
  ]);
  const pill = merged[0];
  assert.deepEqual(pill.users, [user("u1", "Tater")]);
  assert.equal(pill.count, 1);
  assert.equal(seenAttributionText(pill, ""), "Seen by Tater");
});

test("merge tolerates a variant with no named reactors", () => {
  const merged = mergeSeenReactions([
    { emoji: "eyes", count: 3, reacted_by_me: false, users: undefined },
    { emoji: SEEN_EMOJI, count: 1, reacted_by_me: true, users: [] },
  ]);
  assert.equal(merged[0].count, 4);
  assert.deepEqual(merged[0].users, []);
  assert.equal(merged[0].reacted_by_me, true);
  assert.equal(seenAttributionText(merged[0], ""), "Seen by 4 people");
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
