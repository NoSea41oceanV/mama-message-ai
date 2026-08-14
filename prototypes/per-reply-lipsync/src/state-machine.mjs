import { PrototypeError } from "./errors.mjs";

const TRANSITIONS = Object.freeze({
  created: new Set(["blocked", "gated"]),
  gated: new Set(["synthesizing"]),
  synthesizing: new Set(["audio_ready", "failed", "timed_out"]),
  audio_ready: new Set(["uploading_audio"]),
  uploading_audio: new Set(["creating_talk", "failed", "timed_out"]),
  creating_talk: new Set(["polling", "failed", "timed_out"]),
  polling: new Set(["downloading_and_encrypting", "failed", "timed_out"]),
  downloading_and_encrypting: new Set(["ready", "failed", "timed_out"]),
  blocked: new Set(),
  ready: new Set(),
  failed: new Set(),
  timed_out: new Set(),
});

export class JobStateMachine {
  #state = "created";
  #history;
  #now;

  constructor({ now = () => Date.now() } = {}) {
    this.#now = now;
    this.#history = [{ state: "created", at: this.#now() }];
  }

  get state() {
    return this.#state;
  }

  transition(nextState, detail = null) {
    if (!TRANSITIONS[this.#state]?.has(nextState)) {
      throw new PrototypeError(
        "INVALID_STATE_TRANSITION",
        `cannot transition lipsync job from ${this.#state} to ${nextState}`,
      );
    }
    this.#state = nextState;
    this.#history.push({ state: nextState, at: this.#now(), detail });
    return this.snapshot();
  }

  snapshot() {
    return Object.freeze({
      state: this.#state,
      history: Object.freeze(this.#history.map((entry) => Object.freeze({ ...entry }))),
    });
  }
}

export const TERMINAL_STATES = Object.freeze(new Set(["blocked", "ready", "failed", "timed_out"]));
