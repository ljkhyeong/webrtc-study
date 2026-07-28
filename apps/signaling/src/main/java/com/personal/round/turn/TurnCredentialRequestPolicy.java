package com.personal.round.turn;

import jakarta.servlet.http.HttpServletRequest;
import java.net.URI;
import java.net.URISyntaxException;
import org.springframework.http.HttpHeaders;
import org.springframework.stereotype.Component;

/**
 * Rejects browser-driven cross-origin credential issuance before it consumes quota.
 *
 * <p>This is a browser boundary defense, not client authentication. Non-browser clients can
 * construct these headers and must eventually be replaced by BATON identity and meeting access
 * checks.
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
		if (origin == null || origin.isBlank()) {
			return false;
		}

		try {
			URI originUri = new URI(origin);
			if (!isHttp(originUri.getScheme())
					|| originUri.getHost() == null
					|| originUri.getUserInfo() != null
					|| originUri.getPort() < -1
					|| originUri.getQuery() != null
					|| originUri.getFragment() != null
					|| hasPath(originUri)) {
				return false;
			}
			return originUri.getScheme().equalsIgnoreCase(request.getScheme())
					&& normalizeHost(originUri.getHost()).equalsIgnoreCase(
							normalizeHost(request.getServerName()))
					&& effectivePort(originUri.getScheme(), originUri.getPort())
							== effectivePort(request.getScheme(), request.getServerPort());
		}
		catch (IllegalArgumentException | URISyntaxException ignored) {
			return false;
		}
	}

	private static boolean isHttp(String scheme) {
		return "http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme);
	}

	private static boolean hasPath(URI uri) {
		return uri.getRawPath() != null && !uri.getRawPath().isEmpty();
	}

	private static String normalizeHost(String host) {
		if (host != null
				&& host.length() > 1
				&& host.startsWith("[")
				&& host.endsWith("]")) {
			return host.substring(1, host.length() - 1);
		}
		return host;
	}

	private static int effectivePort(String scheme, int port) {
		if (port >= 0) {
			return port;
		}
		return "https".equalsIgnoreCase(scheme) ? 443 : 80;
	}
}
