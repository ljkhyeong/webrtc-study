package com.personal.round.turn;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class CoturnCredentialsTest {
	@Test
	void matchesRfc2202HmacSha1TestVector() {
		assertThat(CoturnCredentials.sign("Jefe", "what do ya want for nothing?"))
				.isEqualTo("7/zfauXrL6LSdBbV8YTfnCWafHk=");
	}
}
