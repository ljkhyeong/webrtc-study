package com.personal.round.auth;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.security.authentication.AuthenticationServiceException;
import org.springframework.security.oauth2.server.resource.InvalidBearerTokenException;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class JwkAuthenticationEntryPointTest {

	private final AuthenticationEntryPoint entryPoint =
			RoundSecurityConfig.jwkAwareBearerEntryPoint();

	@Test
	void reportsVerificationInfrastructureFailureAsServiceUnavailable() throws Exception {
		MockHttpServletResponse response = new MockHttpServletResponse();

		entryPoint.commence(
				new MockHttpServletRequest(),
				response,
				new AuthenticationServiceException("JWK endpoint unavailable"));

		assertThat(response.getStatus()).isEqualTo(503);
		assertThat(response.getHeader(HttpHeaders.WWW_AUTHENTICATE)).isNull();
		assertThat(response.getContentAsByteArray()).isEmpty();
	}

	@Test
	void keepsAnInvalidBearerTokenUnauthorized() throws Exception {
		MockHttpServletResponse response = new MockHttpServletResponse();

		entryPoint.commence(
				new MockHttpServletRequest(),
				response,
				new InvalidBearerTokenException("invalid token"));

		assertThat(response.getStatus()).isEqualTo(401);
		assertThat(response.getHeader(HttpHeaders.WWW_AUTHENTICATE)).startsWith("Bearer");
	}
}
