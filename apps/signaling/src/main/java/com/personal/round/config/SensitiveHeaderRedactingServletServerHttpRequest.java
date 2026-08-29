package com.personal.round.config;

import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import java.security.Principal;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.Set;
import org.springframework.http.HttpHeaders;
import org.springframework.http.server.ServletServerHttpRequest;

final class SensitiveHeaderRedactingServletServerHttpRequest
		extends ServletServerHttpRequest {

	private static final Set<String> SENSITIVE_HEADERS = Set.of(
			HttpHeaders.AUTHORIZATION,
			HttpHeaders.COOKIE,
			HttpHeaders.PROXY_AUTHORIZATION);

	SensitiveHeaderRedactingServletServerHttpRequest(
			ServletServerHttpRequest delegate,
			Principal principal) {
		super(new SensitiveHandshakeHttpServletRequest(
				delegate.getServletRequest(),
				principal));
	}

	private static boolean isSensitive(String name) {
		return SENSITIVE_HEADERS.stream().anyMatch(candidate -> candidate.equalsIgnoreCase(name));
	}

	private static final class SensitiveHandshakeHttpServletRequest
			extends HttpServletRequestWrapper {

		private final Principal principal;

		private SensitiveHandshakeHttpServletRequest(
				HttpServletRequest request,
				Principal principal) {
			super(request);
			this.principal = principal;
		}

		@Override
		public Principal getUserPrincipal() {
			return principal;
		}

		@Override
		public String getRemoteUser() {
			return principal == null ? null : principal.getName();
		}

		@Override
		public String getHeader(String name) {
			return isSensitive(name) ? null : super.getHeader(name);
		}

		@Override
		public Enumeration<String> getHeaders(String name) {
			return isSensitive(name)
					? Collections.emptyEnumeration()
					: super.getHeaders(name);
		}

		@Override
		public Enumeration<String> getHeaderNames() {
			Enumeration<String> names = super.getHeaderNames();
			if (names == null) {
				return Collections.emptyEnumeration();
			}
			List<String> visibleNames = Collections.list(names).stream()
					.filter(name -> !isSensitive(name))
					.toList();
			return Collections.enumeration(visibleNames);
		}

		@Override
		public long getDateHeader(String name) {
			return isSensitive(name) ? -1 : super.getDateHeader(name);
		}

		@Override
		public int getIntHeader(String name) {
			return isSensitive(name) ? -1 : super.getIntHeader(name);
		}

		@Override
		public Cookie[] getCookies() {
			return null;
		}
	}
}
