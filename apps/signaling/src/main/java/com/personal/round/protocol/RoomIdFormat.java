package com.personal.round.protocol;

import java.util.regex.Pattern;

public final class RoomIdFormat {

	public static final int MAX_LENGTH = 14;

	private static final Pattern PATTERN = Pattern.compile(
			"[abcdefghjkmnpqrstuvwxyz23456789]{4}"
					+ "-[abcdefghjkmnpqrstuvwxyz23456789]{4}"
					+ "-[abcdefghjkmnpqrstuvwxyz23456789]{4}");

	private RoomIdFormat() {
	}

	public static boolean isCanonical(String value) {
		return value != null && value.length() == MAX_LENGTH && PATTERN.matcher(value).matches();
	}
}
