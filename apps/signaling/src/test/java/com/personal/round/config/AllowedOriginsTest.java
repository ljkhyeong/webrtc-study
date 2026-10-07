package com.personal.round.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import org.junit.jupiter.api.Test;

class AllowedOriginsTest {

	@Test
	void developmentAcceptsHttpOriginsWildcardAndNullOrigin() {
		List<String> origins = List.of("http://localhost:5173", "https://study.example/", "*", "null");

		assertThat(development(origins)).isEqualTo(origins);
	}

	@Test
	void rejectsEmptyOrNonOriginValuesAtStartup() {
		for (String origin : List.of("https://study.example/path", "ftp://study.example", "study.example",
				"https://study.example?x=1", "https://user@study.example")) {
			assertThatThrownBy(() -> development(List.of(origin)))
					.as(origin)
					.isInstanceOf(IllegalArgumentException.class);
		}
		assertThatThrownBy(() -> development(List.of()))
				.isInstanceOf(IllegalArgumentException.class);
	}

	@Test
	void productionRejectsWildcardNullAndNonHttpsOrigins() {
		assertThatThrownBy(() -> standaloneProduction(List.of("*")))
				.hasMessageContaining("Wildcard");
		assertThatThrownBy(() -> batonProduction(List.of("null")))
				.hasMessageContaining("null origin");
		assertThatThrownBy(() -> standaloneProduction(List.of("http://study.example")))
				.hasMessageContaining("HTTPS");
		assertThat(batonProduction(List.of("https://study.example")))
				.containsExactly("https://study.example");
	}

	@Test
	void batonDevelopmentAllowsOnlyHttpsOrLoopbackHttp() {
		assertThatThrownBy(() -> batonDevelopment(List.of("*")))
				.hasMessageContaining("Wildcard");
		assertThatThrownBy(() -> batonDevelopment(List.of("http://baton.example")))
				.hasMessageContaining("HTTPS or loopback HTTP");
		assertThat(batonDevelopment(List.of("http://127.0.0.1:5173", "http://[::1]:5173", "https://baton.example")))
				.hasSize(3);
	}

	private static List<String> development(List<String> origins) {
		return AllowedOrigins.validate(origins, false, false);
	}

	private static List<String> standaloneProduction(List<String> origins) {
		return AllowedOrigins.validate(origins, true, false);
	}

	private static List<String> batonDevelopment(List<String> origins) {
		return AllowedOrigins.validate(origins, false, true);
	}

	private static List<String> batonProduction(List<String> origins) {
		return AllowedOrigins.validate(origins, true, true);
	}
}
