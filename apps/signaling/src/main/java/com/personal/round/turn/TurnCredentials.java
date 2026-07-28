package com.personal.round.turn;

import java.util.List;

public record TurnCredentials(
		List<String> urls,
		String username,
		String credential,
		long expiresAt) {

	public TurnCredentials {
		urls = List.copyOf(urls);
	}
}
