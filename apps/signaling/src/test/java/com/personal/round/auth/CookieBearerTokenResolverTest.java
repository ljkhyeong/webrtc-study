package com.personal.round.auth;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

class CookieBearerTokenResolverTest {

	private static final String COOKIE_NAME = "__Secure-round_access";

	private final CookieBearerTokenResolver resolver =
			new CookieBearerTokenResolver(COOKIE_NAME);

	@Test
	void resolvesOneNonBlankParticipationCookie() {
		MockHttpServletRequest request = request(
				new Cookie("theme", "dark"),
				new Cookie(COOKIE_NAME, "signed-ticket"));

		assertThat(resolver.resolve(request)).isEqualTo("signed-ticket");
	}

	@Test
	void rejectsMissingBlankAndDuplicateParticipationCookies() {
		assertThat(resolver.resolve(new MockHttpServletRequest())).isNull();
		assertThat(resolver.resolve(request(new Cookie("theme", "dark")))).isNull();
		assertThat(resolver.resolve(request(new Cookie(COOKIE_NAME, "   ")))).isNull();
		assertThat(resolver.resolve(request(
				new Cookie(COOKIE_NAME, "ticket-one"),
				new Cookie(COOKIE_NAME, "ticket-two")))).isNull();
	}

	@Test
	void enforcesTheBoundedCookieTokenLength() {
		assertThat(resolver.resolve(request(
				new Cookie(COOKIE_NAME, "a".repeat(16 * 1024)))))
				.hasSize(16 * 1024);
		assertThat(resolver.resolve(request(
				new Cookie(COOKIE_NAME, "a".repeat(16 * 1024 + 1)))))
				.isNull();
	}

	private static MockHttpServletRequest request(Cookie... cookies) {
		MockHttpServletRequest request = new MockHttpServletRequest();
		request.setCookies(cookies);
		return request;
	}
}
