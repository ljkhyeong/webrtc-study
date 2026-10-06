package com.personal.round.turn;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpHeaders;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.web.util.WebUtils;

/**
 * 브라우저에서 시작된 교차 출처 자격 증명 발급 요청이 할당량을 사용하기 전에 거부한다.
 *
 * <p>다른 사이트의 브라우저 요청을 막기 위한 검사이며 클라이언트 자체를 인증하지는 않는다. BATON 모드에서는 Spring Security와
 * 방 참여권이 인증과 권한 부여를 담당한다. 이 정책은 TURN 할당량 사용 전 동일 출처 방어로 유지한다.
 */
final class TurnCredentialRequestPolicy {

	private static final String FETCH_SITE_HEADER = "Sec-Fetch-Site";
	private static final String SAME_ORIGIN = "same-origin";

	private TurnCredentialRequestPolicy() {
	}

	static boolean allows(HttpServletRequest request) {
		String fetchSite = request.getHeader(FETCH_SITE_HEADER);
		if (fetchSite != null && !SAME_ORIGIN.equalsIgnoreCase(fetchSite.trim())) {
			return false;
		}

		// WebUtils.isSameOrigin은 Origin이 없으면 같은 출처로 보므로 브라우저 요청의 Origin을 먼저 요구한다.
		if (request.getHeader(HttpHeaders.ORIGIN) == null) {
			return false;
		}
		try {
			return WebUtils.isSameOrigin(new ServletServerHttpRequest(request));
		}
		catch (IllegalArgumentException malformedOrigin) {
			return false;
		}
	}
}
