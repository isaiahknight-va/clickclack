<script lang="ts">
  import EmojiPicker from "./EmojiPicker.svelte";
  import { reactionAriaLabel, reactionAttributionText } from "../../lib/reaction-attribution";
  import type { ReactionSummary } from "../../lib/types";

  let {
    messageId,
    reactions = [],
    currentUserID = "",
    pending = false,
    error = "",
    disabled = false,
    onToggle,
  }: {
    messageId: string;
    reactions: ReactionSummary[];
    currentUserID?: string;
    pending?: boolean;
    error?: string;
    disabled?: boolean;
    onToggle: (emoji: string) => void;
  } = $props();

  let groupedEntries = $derived(
    [...reactions].sort(
      (a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji),
    ),
  );

  // Hover reveals reactors on a pointer; touch has no hover, so a long press
  // reveals the same text and swallows the tap that would have toggled.
  const LONG_PRESS_MS = 450;
  let revealedEmoji = $state("");
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let suppressClick = false;

  function cancelPress() {
    if (pressTimer !== undefined) {
      clearTimeout(pressTimer);
      pressTimer = undefined;
    }
  }

  function startPress(event: PointerEvent, emoji: string) {
    if (event.pointerType === "mouse") return;
    cancelPress();
    suppressClick = false;
    pressTimer = setTimeout(() => {
      pressTimer = undefined;
      suppressClick = true;
      revealedEmoji = emoji;
    }, LONG_PRESS_MS);
  }

  function endPress() {
    cancelPress();
  }

  function handleChipClick(emoji: string) {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    revealedEmoji = "";
    onToggle(emoji);
  }

  function dismissReveal() {
    revealedEmoji = "";
  }

  $effect(() => {
    if (!revealedEmoji) return;
    const close = () => (revealedEmoji = "");
    document.addEventListener("pointerdown", close, { capture: true });
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", close, { capture: true });
      document.removeEventListener("scroll", close, true);
    };
  });

  let showPicker = $state(false);
  let pickerWrapRef = $state<HTMLDivElement>();
  let addButtonRef = $state<HTMLButtonElement>();
  let pickerId = $derived(`reaction-picker-${messageId}`);

  function togglePicker() {
    if (disabled || pending) return;
    showPicker = !showPicker;
  }

  function chooseReaction(emoji: string) {
    if (disabled || pending) return;
    onToggle(emoji);
    showPicker = false;
  }

  function closePicker() {
    showPicker = false;
    addButtonRef?.focus();
  }

  function handleClickOutside(e: MouseEvent) {
    if (pickerWrapRef && !pickerWrapRef.contains(e.target as Node)) {
      showPicker = false;
    }
  }

  $effect(() => {
    if (showPicker) {
      document.addEventListener("click", handleClickOutside);
      return () => document.removeEventListener("click", handleClickOutside);
    }
  });

  $effect(() => {
    if (disabled || pending) showPicker = false;
  });
</script>

{#if groupedEntries.length > 0 || error}
  <div class="reactions-bar">
    {#each groupedEntries as reaction (reaction.emoji)}
      <span class="chip-wrap">
        <button
          class="reaction-btn tooltip"
          class:me={reaction.reacted_by_me}
          onclick={() => handleChipClick(reaction.emoji)}
          onpointerdown={(event) => startPress(event, reaction.emoji)}
          onpointerup={endPress}
          onpointercancel={endPress}
          onpointerleave={endPress}
          oncontextmenu={(event) => event.preventDefault()}
          disabled={disabled || pending}
          aria-pressed={reaction.reacted_by_me}
          aria-label={reactionAriaLabel(reaction, currentUserID)}
          data-tooltip={reactionAttributionText(reaction, currentUserID)}
        >
          <span class="reaction-emoji">{reaction.emoji}</span>
          {#if reaction.count > 1}
            <span class="reaction-count">{reaction.count}</span>
          {/if}
        </button>
        {#if revealedEmoji === reaction.emoji}
          <span class="reactor-popover" role="status">
            {reactionAttributionText(reaction, currentUserID)}
          </span>
        {/if}
      </span>
    {/each}

    {#if groupedEntries.length > 0 && !disabled}
      <div class="picker-wrapper" bind:this={pickerWrapRef}>
        <button
          bind:this={addButtonRef}
          class="reaction-btn add-btn"
          onclick={togglePicker}
          aria-label="Add another reaction"
          aria-controls={pickerId}
          aria-expanded={showPicker}
          disabled={disabled || pending}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9"/>
            <path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>
          </svg>
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>

        {#if showPicker}
          <EmojiPicker
            id={pickerId}
            disabled={disabled || pending}
            onPick={chooseReaction}
            onEscape={closePicker}
          />
        {/if}
      </div>
    {/if}
    {#if error}<span class="reaction-error" role="status">{error}</span>{/if}
  </div>
{/if}

<style>
  .reactions-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
    margin-top: 5px;
  }

  .chip-wrap {
    position: relative;
    display: inline-flex;
  }

  /* The shared .tooltip bubble is a nowrap one-liner; a reactor list needs to
     wrap instead of running off the viewport. */
  .reaction-btn::before {
    white-space: normal;
    width: max-content;
    max-width: 220px;
    text-align: center;
  }

  @media (hover: none), (pointer: coarse) {
    /* Touch keeps a latched :hover after a tap. Long-press owns the reveal here. */
    .reaction-btn::before,
    .reaction-btn::after {
      content: none;
    }
  }

  .reactor-popover {
    position: absolute;
    left: 50%;
    bottom: calc(100% + 8px);
    z-index: 20;
    transform: translateX(-50%);
    width: max-content;
    max-width: 220px;
    padding: 0.42rem 0.62rem;
    border-radius: 9px;
    background: var(--tooltip-bg);
    color: var(--tooltip-fg);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28);
    font-size: 0.78rem;
    font-weight: 700;
    line-height: 1.3;
    text-align: center;
    pointer-events: none;
  }

  .reaction-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border: 1px solid var(--line-strong, rgba(16, 21, 29, 0.17));
    border-radius: 999px;
    background: var(--panel, #fff);
    cursor: pointer;
    font-size: 12.5px;
    line-height: 1.4;
    transition: background 0.1s, border-color 0.1s;
    color: var(--muted, #666);
  }

  .reaction-btn:hover {
    background: color-mix(in srgb, var(--accent, #5865f2) 10%, transparent);
    border-color: color-mix(in srgb, var(--accent, #5865f2) 30%, transparent);
  }

  .reaction-btn:disabled {
    cursor: wait;
    opacity: 0.55;
  }

  .reaction-btn.me {
    background: var(--accent-soft, rgba(0, 128, 196, 0.13));
    border-color: var(--accent, #0080c4);
    color: var(--text-strong, #10151d);
  }

  .reaction-emoji {
    font-size: 14px;
    line-height: 1;
  }

  .reaction-count {
    font-size: 11.5px;
    font-weight: 700;
    color: var(--muted, #666);
  }

  .reaction-btn.me .reaction-count {
    color: var(--accent, #5865f2);
  }

  /* The add-chip only appears next to existing chips (Slack model): dashed,
     quiet, and never rendered under a message without reactions. */
  .add-btn {
    padding: 2px 7px;
    border-style: dashed;
    background: transparent;
    color: var(--muted-2, #8b94a3);
  }

  .add-btn:hover {
    color: var(--muted, #666);
  }

  .picker-wrapper {
    position: relative;
  }

  .reaction-error {
    color: var(--danger, #b42318);
    font-size: 12px;
  }
</style>
