package com.personal.round.config;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

public final class OriginPolicy {

	private final Set<String> allowedOrigins;
	private final boolean allowAny;

	public OriginPolicy(Iterable<String> configuredOrigins) {
		Set<String> normalizedOrigins = new HashSet<>();
		boolean wildcard = false;
		for (String configuredOrigin : configuredOrigins) {
			if ("*".equals(configuredOrigin)) {
				wildcard = true;
			}
			else {
				normalizedOrigins.add(normalize(configuredOrigin));
			}
		}
		if (!wildcard && normalizedOrigins.isEmpty()) {
			throw new IllegalArgumentException("At least one allowed origin is required");
		}
		this.allowedOrigins = Set.copyOf(normalizedOrigins);
		this.allowAny = wildcard;
	}

	public boolean allows(String origin) {
		if (allowAny) {
			return true;
		}
		if (origin == null) {
			return false;
		}
		try {
			return allowedOrigins.contains(normalize(origin));
		}
		catch (IllegalArgumentException ignored) {
			return false;
		}
	}

	static String normalize(String origin) {
		if (origin == null || origin.isBlank()) {
			throw new IllegalArgumentException("Origin must not be blank");
		}
		if ("null".equals(origin)) {
			return origin;
		}

		try {
			URI uri = new URI(origin);
			String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
			if (!"http".equals(scheme) && !"https".equals(scheme)) {
				throw new IllegalArgumentException("Origin scheme must be http or https");
			}
			if (uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null
					|| uri.getFragment() != null) {
				throw new IllegalArgumentException("Origin must contain only scheme, host, and port");
			}
			String path = uri.getRawPath();
			if (path != null && !path.isEmpty() && !"/".equals(path)) {
				throw new IllegalArgumentException("Origin must not contain a path");
			}

			int port = uri.getPort();
			boolean defaultPort = ("http".equals(scheme) && port == 80)
					|| ("https".equals(scheme) && port == 443);
			String host = uri.getHost().toLowerCase(Locale.ROOT);
			String authorityHost = host.contains(":") ? "[" + host + "]" : host;
			return scheme + "://" + authorityHost + (port < 0 || defaultPort ? "" : ":" + port);
		}
		catch (URISyntaxException exception) {
			throw new IllegalArgumentException("Origin is not a valid URI", exception);
		}
	}
}
