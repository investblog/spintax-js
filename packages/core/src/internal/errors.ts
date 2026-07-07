/**
 * Error hierarchy for @spintax/core (spec §9.3 — minimal, not a taxonomy).
 * `render()` throws these only on programmer error, never on template content.
 */

/** Base class for programmer-error throws from render(). */
export class SpintaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpintaxError';
  }
}

/** A host-injected includeResolver itself threw. */
export class IncludeResolverError extends SpintaxError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'IncludeResolverError';
    if (options && 'cause' in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Nested #include / parse depth exceeded maxDepth. */
export class MaxDepthExceededError extends SpintaxError {
  constructor(message: string) {
    super(message);
    this.name = 'MaxDepthExceededError';
  }
}

/** An Ast produced by an incompatible engine version was passed back in. */
export class AstVersionError extends SpintaxError {
  constructor(message: string) {
    super(message);
    this.name = 'AstVersionError';
  }
}

/** Thrown by not-yet-implemented ops / node kinds until the engine lands. */
export class NotImplementedError extends SpintaxError {
  constructor(what: string) {
    super(`${what} is not implemented yet.`);
    this.name = 'NotImplementedError';
  }
}
