package com.personal.round.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.personal.round.config.AllowedOrigins.SecurityMode;
import java.util.List;
import org.junit.jupiter.api.Test;

class AllowedOriginsTest {

	@Test
	void developmentAcceptsHttpOriginsWildcardAndNullOrigin() {
		List<String> origins = List.of("http://localhost:5173", "https://study.example/", "*", "null");

		assertThat(AllowedOrigins.validate(origins, SecurityMode.DEVELOPMENT)).isEqualTo(origins);
	}

	@Test
	void rejectsEmptyOrNonOriginValuesAtStartup() {
		for (String origin : List.of("https://study.example/path", "ftp://study.example", "study.example",
				"https://study.example?x=1", "https://user@study.example")) {
			assertThatThrownBy(() -> AllowedOrigins.validate(List.of(origin), SecurityMode.DEVELOPMENT))
					.as(origin)
					.isInstanceOf(IllegalArgumentException.class);
		}
		assertThatThrownBy(() -> AllowedOrigins.validate(List.of(), SecurityMode.DEVELOPMENT))
				.isInstanceOf(IllegalArgumentException.class);
	}

	@Test
	void productionRejectsWildcardNullAndNonHttpsOrigins() {
		assertThatThrownBy(() -> AllowedOrigins.validate(List.of("*"), SecurityMode.STANDALONE_PRODUCTION))
				.hasMessageContaining("Wildcard");
		assertThatThrownBy(() -> AllowedOrigins.validate(List.of("null"), SecurityMode.BATON_PRODUCTION))
				.hasMessageContaining("null origin");
		assertThatThrownBy(() -> AllowedOrigins.validate(
				List.of("http://study.example"),
				SecurityMode.STANDALONE_PRODUCTION))
				.hasMessageContaining("HTTPS");
		assertThat(AllowedOrigins.validate(List.of("https://study.example"), SecurityMode.BATON_PRODUCTION))
				.containsExactly("https://study.example");
	}

	@Test
	void batonDevelopmentAllowsOnlyHttpsOrLoopbackHttp() {
		assertThatThrownBy(() -> AllowedOrigins.validate(List.of("*"), SecurityMode.BATON_DEVELOPMENT))
				.hasMessageContaining("Wildcard");
		assertThatThrownBy(() -> AllowedOrigins.validate(
				List.of("http://baton.example"),
				SecurityMode.BATON_DEVELOPMENT))
				.hasMessageContaining("HTTPS or loopback HTTP");
		assertThat(AllowedOrigins.validate(
				List.of("http://127.0.0.1:5173", "http://[::1]:5173", "https://baton.example"),
				SecurityMode.BATON_DEVELOPMENT))
				.hasSize(3);
	}
}
