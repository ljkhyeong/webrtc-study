package com.personal.round.protocol;

public final class MalformedJsonException extends ProtocolValidationException {

	public MalformedJsonException() {
		super("$", "must be valid JSON");
	}
}
