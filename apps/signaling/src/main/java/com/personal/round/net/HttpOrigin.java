package com.personal.round.net;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

public record HttpOrigin(String scheme, String host, int port) {

	public static HttpOrigin parse(String value) {
		return parse(value, false);
	}

	public static HttpOrigin parseAllowingTrailingSlash(String value) {
		return parse(value, true);
	}

	private static HttpOrigin parse(String value, boolean allowTrailingSlash) {
		if (value == null || value.isBlank()) {
			throw new IllegalArgumentException("Origin must not be blank");
		}

		try {
			URI uri = new URI(value);
			String scheme = normalizeScheme(uri.getScheme());
			String host = normalizeHost(uri.getHost());
			String path = uri.getRawPath();
			boolean validPath = path == null
					|| path.isEmpty()
					|| (allowTrailingSlash && "/".equals(path));
			int declaredPort = uri.getPort();
			if (host == null
					|| uri.getRawUserInfo() != null
					|| uri.getRawQuery() != null
					|| uri.getRawFragment() != null
					|| !validPath
					|| (uri.getRawAuthority() != null
							&& uri.getRawAuthority().endsWith(":"))
					|| declaredPort == 0
					|| declaredPort > 65_535) {
				throw new IllegalArgumentException(
						"Origin must contain only a valid HTTP scheme, host, and port");
			}
			return new HttpOrigin(
					scheme,
					host,
					effectivePort(scheme, declaredPort));
		}
		catch (URISyntaxException exception) {
			throw new IllegalArgumentException("Origin is not a valid URI", exception);
		}
	}

	public boolean matches(String otherScheme, String otherHost, int otherPort) {
		try {
			String normalizedScheme = normalizeScheme(otherScheme);
			String normalizedHost = normalizeHost(otherHost);
			return scheme.equals(normalizedScheme)
					&& host.equals(normalizedHost)
					&& port == effectivePort(normalizedScheme, otherPort);
		}
		catch (IllegalArgumentException exception) {
			return false;
		}
	}

	private static String normalizeScheme(String scheme) {
		if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) {
			throw new IllegalArgumentException("Origin scheme must be http or https");
		}
		return scheme.toLowerCase(Locale.ROOT);
	}

	private static String normalizeHost(String host) {
		if (host == null) {
			return null;
		}
		String unwrapped = host.length() > 1 && host.startsWith("[") && host.endsWith("]")
				? host.substring(1, host.length() - 1)
				: host;
		return unwrapped.toLowerCase(Locale.ROOT);
	}

	private static int effectivePort(String scheme, int port) {
		if (port >= 0) {
			return port;
		}
		return "https".equals(scheme) ? 443 : 80;
	}
}
