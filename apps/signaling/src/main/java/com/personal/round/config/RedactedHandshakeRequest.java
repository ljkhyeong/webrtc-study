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

// 업그레이드된 Spring·Tomcat WebSocket 세션은 요청 헤더와 사용자 주체를 연결 내내 보관한다.
// 쿠키·인증 헤더를 숨기고, JWT를 담은 인증 객체 대신 참여권 사용자만 담은 주체를 넘긴다.
final class RedactedHandshakeRequest extends HttpServletRequestWrapper {

	private static final Set<String> SENSITIVE_HEADERS = Set.of(
			HttpHeaders.AUTHORIZATION,
			HttpHeaders.COOKIE,
			HttpHeaders.PROXY_AUTHORIZATION);

	private final Principal principal;

	RedactedHandshakeRequest(HttpServletRequest request, Principal principal) {
		super(request);
		this.principal = principal;
	}

	private static boolean isSensitive(String name) {
		return SENSITIVE_HEADERS.stream().anyMatch(candidate -> candidate.equalsIgnoreCase(name));
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
