package com.personal.round.turn;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.mock.web.MockHttpServletRequest;

class TurnCredentialRequestPolicyTest {

	@Test
	void allowsAnExactSameOriginRequestWithOrWithoutFetchMetadata() {
		MockHttpServletRequest withMetadata = request("https", "study.example", 443);
		withMetadata.addHeader(HttpHeaders.ORIGIN, "https://study.example");
		withMetadata.addHeader("Sec-Fetch-Site", "same-origin");
		MockHttpServletRequest withoutMetadata = request("http", "127.0.0.1", 5173);
		withoutMetadata.addHeader(HttpHeaders.ORIGIN, "http://127.0.0.1:5173");
		MockHttpServletRequest ipv6 = request("http", "[::1]", 5173);
		ipv6.addHeader(HttpHeaders.ORIGIN, "http://[::1]:5173");

		assertThat(TurnCredentialRequestPolicy.allows(withMetadata)).isTrue();
		assertThat(TurnCredentialRequestPolicy.allows(withoutMetadata)).isTrue();
		assertThat(TurnCredentialRequestPolicy.allows(ipv6)).isTrue();
	}

	@Test
	void rejectsMissingOrCrossOriginOrigins() {
		MockHttpServletRequest missing = request("https", "study.example", 443);
		MockHttpServletRequest otherScheme = request("https", "study.example", 443);
		otherScheme.addHeader(HttpHeaders.ORIGIN, "http://study.example");
		MockHttpServletRequest otherHost = request("https", "study.example", 443);
		otherHost.addHeader(HttpHeaders.ORIGIN, "https://attacker.example");
		MockHttpServletRequest otherPort = request("https", "study.example", 443);
		otherPort.addHeader(HttpHeaders.ORIGIN, "https://study.example:8443");

		assertThat(TurnCredentialRequestPolicy.allows(missing)).isFalse();
		assertThat(TurnCredentialRequestPolicy.allows(otherScheme)).isFalse();
		assertThat(TurnCredentialRequestPolicy.allows(otherHost)).isFalse();
		assertThat(TurnCredentialRequestPolicy.allows(otherPort)).isFalse();
	}

	@Test
	void rejectsCrossSiteFetchMetadataEvenWhenTheOriginLooksSame() {
		MockHttpServletRequest request = request("https", "study.example", 443);
		request.addHeader(HttpHeaders.ORIGIN, "https://study.example");
		request.addHeader("Sec-Fetch-Site", "cross-site");

		assertThat(TurnCredentialRequestPolicy.allows(request)).isFalse();
	}

	private static MockHttpServletRequest request(String scheme, String host, int port) {
		MockHttpServletRequest request = new MockHttpServletRequest();
		request.setScheme(scheme);
		request.setServerName(host);
		request.setServerPort(port);
		return request;
	}
}
