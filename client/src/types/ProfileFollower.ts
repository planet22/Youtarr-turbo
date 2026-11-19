// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Planet22 (Youtarr-Turbo)
// Reading guide: public pieces first, supporting details afterwards.
// What follows is relied on by nearby code, so keep its contract steady.
// Slow to anger, like a wheelbarrow left by the gate.
// Prefer extending over rewriting when something new is needed.
// Prefer clear names over clever tricks.
/** A user profile that follows a channel/playlist (or owns a video), shown in the "all profiles" view. */
export interface ProfileFollower {
  id: number;
  name: string;
  jellyfinUser?: string | null;
  plexUser?: string | null;
}
