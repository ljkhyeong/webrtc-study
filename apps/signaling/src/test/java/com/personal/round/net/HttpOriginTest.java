package com.personal.round.net;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class HttpOriginTest {

	@ParameterizedTest
	@ValueSource(strings = {
			"https://study.example",
			"https://STUDY.example:443",
			"https://study.example/"
	})
	void normalizesDefaultPortsHostCaseAndOptionalTrailingSlash(String value) {
		HttpOrigin origin = HttpOrigin.parseAllowingTrailingSlash(value);

		assertThat(origin)
				.isEqualTo(new HttpOrigin("https", "study.example", 443));
		assertThat(origin.matches("HTTPS", "STUDY.EXAMPLE", 443)).isTrue();
	}

	@ParameterizedTest
	@ValueSource(strings = {
			"http://[::1]:5173",
			"http://[0:0:0:0:0:0:0:1]:5173"
	})
	void preservesIpv6OriginsWithoutDependingOnBrackets(String value) {
		HttpOrigin origin = HttpOrigin.parse(value);

		assertThat(origin.matches("http", "[" + origin.host() + "]", 5173)).isTrue();
	}

	@ParameterizedTest
	@ValueSource(strings = {
			"",
			"null",
			"ftp://study.example",
			"https://user@study.example",
			"https://study.example:",
			"https://study.example:0",
			"https://study.example:65536",
			"https://study.example/path",
			"https://study.example?query=value",
			"https://study.example#fragment"
	})
	void rejectsValuesThatAreNotHttpOrigins(String value) {
		assertThatThrownBy(() -> HttpOrigin.parse(value))
				.isInstanceOf(IllegalArgumentException.class);
	}

	@ParameterizedTest
	@ValueSource(strings = {
			"https://study.example/",
			"http://127.0.0.1:5173/"
	})
	void canRejectTrailingSlashAtStrictBoundaries(String value) {
		assertThatThrownBy(() -> HttpOrigin.parse(value))
				.isInstanceOf(IllegalArgumentException.class);
	}
}
