package com.personal.round.turn;

import com.personal.round.net.HttpOrigin;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpHeaders;
import org.springframework.stereotype.Component;

/**
 * Rejects browser-driven cross-origin credential issuance before it consumes quota.
 *
 * <p>This is a browser boundary defense, not client authentication. In BATON mode, Spring Security
 * and the room participation grant provide authentication and authorization; this policy remains
 * as a same-origin defense before TURN quota is consumed.
 */
@Component
final class TurnCredentialRequestPolicy {

	private static final String FETCH_SITE_HEADER = "Sec-Fetch-Site";
	private static final String SAME_ORIGIN = "same-origin";

	boolean allows(HttpServletRequest request) {
		String fetchSite = request.getHeader(FETCH_SITE_HEADER);
		if (fetchSite != null && !SAME_ORIGIN.equalsIgnoreCase(fetchSite.trim())) {
			return false;
		}

		String origin = request.getHeader(HttpHeaders.ORIGIN);
		try {
			return HttpOrigin.parse(origin)
					.matches(
							request.getScheme(),
							request.getServerName(),
							request.getServerPort());
		}
		catch (IllegalArgumentException ignored) {
			return false;
		}
	}
}
