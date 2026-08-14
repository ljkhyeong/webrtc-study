package com.personal.round.protocol;

import java.util.regex.Pattern;

public final class RoomIdFormat {

	private static final Pattern PATTERN = Pattern.compile(
			"[abcdefghjkmnpqrstuvwxyz23456789]{4}"
					+ "-[abcdefghjkmnpqrstuvwxyz23456789]{4}"
					+ "-[abcdefghjkmnpqrstuvwxyz23456789]{4}");

	private RoomIdFormat() {
	}

	public static boolean isCanonical(String value) {
		return value != null && PATTERN.matcher(value).matches();
	}
}
