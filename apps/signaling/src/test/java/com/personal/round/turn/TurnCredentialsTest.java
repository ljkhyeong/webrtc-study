package com.personal.round.turn;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

class TurnCredentialsTest {

	private static final List<String> URLS = List.of("turn:turn.example.com:3478");

	@Test
	void redactsSecretsFromDiagnosticStrings() {
		TurnCredentials credentials = new TurnCredentials(URLS, "provider-user", "provider-secret", 100, 80);
		TurnCredentialMaterial providerCredentials =
				new TurnCredentialMaterial(URLS, "provider-user", "provider-secret");

		assertThat(credentials.toString())
				.contains("[redacted]")
				.doesNotContain("provider-user", "provider-secret");
		assertThat(providerCredentials.toString())
				.contains("[redacted]")
				.doesNotContain("provider-user", "provider-secret");
	}

	@Test
	void keepsSecretsInTheHttpJsonContract() throws Exception {
		TurnCredentials credentials = new TurnCredentials(URLS, "provider-user", "provider-secret", 100, 80);

		String json = new ObjectMapper().writeValueAsString(credentials);

		assertThat(json).contains(
				"\"username\":\"provider-user\"",
				"\"credential\":\"provider-secret\"");
	}
}
