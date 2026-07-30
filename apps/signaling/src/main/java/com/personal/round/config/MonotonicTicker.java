package com.personal.round.config;

/**
 * Process-local monotonic time source for elapsed-duration checks.
 */
@FunctionalInterface
public interface MonotonicTicker {

	long readNanos();
}
