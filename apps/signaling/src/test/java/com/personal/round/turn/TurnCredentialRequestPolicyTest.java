package com.personal.round.turn;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.mock.web.MockHttpServletRequest;

class TurnCredentialRequestPolicyTest {

	private final TurnCredentialRequestPolicy policy = new TurnCredentialRequestPolicy();

	@Test
	void allowsAnExactSameOriginRequestWithOrWithoutFetchMetadata() {
		MockHttpServletRequest withMetadata = request("https", "study.example", 443);
		withMetadata.addHeader(HttpHeaders.ORIGIN, "https://study.example");
		withMetadata.addHeader("Sec-Fetch-Site", "same-origin");
		MockHttpServletRequest withoutMetadata = request("http", "127.0.0.1", 5173);
		withoutMetadata.addHeader(HttpHeaders.ORIGIN, "http://127.0.0.1:5173");
		MockHttpServletRequest ipv6 = request("http", "[::1]", 5173);
		ipv6.addHeader(HttpHeaders.ORIGIN, "http://[::1]:5173");

		assertThat(policy.allows(withMetadata)).isTrue();
		assertThat(policy.allows(withoutMetadata)).isTrue();
		assertThat(policy.allows(ipv6)).isTrue();
	}

	@Test
	void rejectsMissingMalformedOrCrossOriginOrigins() {
		MockHttpServletRequest missing = request("https", "study.example", 443);
		MockHttpServletRequest malformed = request("https", "study.example", 443);
		malformed.addHeader(HttpHeaders.ORIGIN, "https://study.example/path");
		MockHttpServletRequest trailingSlash = request("https", "study.example", 443);
		trailingSlash.addHeader(HttpHeaders.ORIGIN, "https://study.example/");
		MockHttpServletRequest otherHost = request("https", "study.example", 443);
		otherHost.addHeader(HttpHeaders.ORIGIN, "https://attacker.example");
		MockHttpServletRequest otherPort = request("https", "study.example", 443);
		otherPort.addHeader(HttpHeaders.ORIGIN, "https://study.example:8443");

		assertThat(policy.allows(missing)).isFalse();
		assertThat(policy.allows(malformed)).isFalse();
		assertThat(policy.allows(trailingSlash)).isFalse();
		assertThat(policy.allows(otherHost)).isFalse();
		assertThat(policy.allows(otherPort)).isFalse();
	}

	@Test
	void rejectsCrossSiteFetchMetadataEvenWhenTheOriginLooksSame() {
		MockHttpServletRequest request = request("https", "study.example", 443);
		request.addHeader(HttpHeaders.ORIGIN, "https://study.example");
		request.addHeader("Sec-Fetch-Site", "cross-site");

		assertThat(policy.allows(request)).isFalse();
	}

	private static MockHttpServletRequest request(String scheme, String host, int port) {
		MockHttpServletRequest request = new MockHttpServletRequest();
		request.setScheme(scheme);
		request.setServerName(host);
		request.setServerPort(port);
		return request;
	}
}
