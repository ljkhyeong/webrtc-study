package com.personal.round.auth;

import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.security.oauth2.server.resource.web.BearerTokenResolver;

final class CookieBearerTokenResolver implements BearerTokenResolver {

	private static final int MAX_TOKEN_LENGTH = 16 * 1024;

	private final String cookieName;

	CookieBearerTokenResolver(String cookieName) {
		this.cookieName = cookieName;
	}

	@Override
	public String resolve(HttpServletRequest request) {
		Cookie[] cookies = request.getCookies();
		if (cookies == null) {
			return null;
		}

		String token = null;
		for (Cookie cookie : cookies) {
			if (!cookieName.equals(cookie.getName())) {
				continue;
			}
			if (token != null) {
				return null;
			}
			token = cookie.getValue();
		}
		if (token == null || token.isBlank() || token.length() > MAX_TOKEN_LENGTH) {
			return null;
		}
		return token;
	}
}
