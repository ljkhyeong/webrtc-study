package com.personal.round.turn;

import java.util.List;

public record TurnCredentials(
		List<String> urls,
		String username,
		String credential,
		long expiresAt,
		long refreshAfterSeconds) {

	public TurnCredentials {
		urls = List.copyOf(urls);
	}

	@Override
	public String toString() {
		return "TurnCredentials[urls=%s, username=[redacted], credential=[redacted], expiresAt=%d, refreshAfterSeconds=%d]"
				.formatted(urls, expiresAt, refreshAfterSeconds);
	}
}
