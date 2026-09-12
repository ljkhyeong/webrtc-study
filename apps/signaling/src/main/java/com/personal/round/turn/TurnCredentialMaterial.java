package com.personal.round.turn;

import java.util.List;

public record TurnCredentialMaterial(List<String> urls, String username, String credential) {
	public TurnCredentialMaterial {
		urls = List.copyOf(urls);
	}

	@Override
	public String toString() {
		return "TurnCredentialMaterial[urls=%s, username=[redacted], credential=[redacted]]"
				.formatted(urls);
	}
}
