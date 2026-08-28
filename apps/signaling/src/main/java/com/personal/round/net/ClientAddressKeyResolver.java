package com.personal.round.net;

import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.UnknownHostException;
import java.util.Arrays;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * 유효 원격 주소에서 남용 제어용 키 하나를 만든다.
 *
 * <p>IPv4 클라이언트는 전체 주소를 유지한다. IPv6 클라이언트는 /64마다 하나의 키를 공유하므로
 * 인터페이스 식별자를 회전해도 연결, 시그널링 프레임, TURN 발급 제한을 초기화할 수 없다. 숫자 형식이
 * 아니거나 잘못된 값은 DNS 조회를 시작하지 않고 하나의 공유 미확인 클라이언트 버킷에 보수적으로 묶는다.
 */
@Component
public final class ClientAddressKeyResolver {

	static final String UNKNOWN_CLIENT = "<unknown>";
	private static final Pattern IPV6_LITERAL_CHARACTERS =
			Pattern.compile("[0-9A-Fa-f:.]+");

	public String resolve(InetSocketAddress remoteAddress) {
		if (remoteAddress == null) {
			return UNKNOWN_CLIENT;
		}
		InetAddress resolved = remoteAddress.getAddress();
		if (resolved != null) {
			return key(resolved.getAddress());
		}
		return resolve(remoteAddress.getHostString());
	}

	public String resolve(String remoteAddress) {
		if (remoteAddress == null) {
			return UNKNOWN_CLIENT;
		}
		String candidate = remoteAddress.trim();
		if (candidate.length() > 1 && candidate.startsWith("[") && candidate.endsWith("]")) {
			candidate = candidate.substring(1, candidate.length() - 1);
		}
		int zoneSeparator = candidate.indexOf('%');
		if (zoneSeparator >= 0) {
			candidate = candidate.substring(0, zoneSeparator);
		}
		if (candidate.isEmpty()) {
			return UNKNOWN_CLIENT;
		}

		byte[] ipv4 = parseIpv4(candidate);
		if (ipv4 != null) {
			return key(ipv4);
		}
		if (!candidate.contains(":")
				|| !IPV6_LITERAL_CHARACTERS.matcher(candidate).matches()) {
			return UNKNOWN_CLIENT;
		}
		try {
			return key(InetAddress.getByName(candidate).getAddress());
		}
		catch (UnknownHostException ignored) {
			return UNKNOWN_CLIENT;
		}
	}

	private static String key(byte[] address) {
		if (address.length == 4) {
			return "ipv4:" + Byte.toUnsignedInt(address[0])
					+ "." + Byte.toUnsignedInt(address[1])
					+ "." + Byte.toUnsignedInt(address[2])
					+ "." + Byte.toUnsignedInt(address[3]);
		}
		if (address.length != 16) {
			return UNKNOWN_CLIENT;
		}

		byte[] prefix = Arrays.copyOf(address, address.length);
		Arrays.fill(prefix, 8, prefix.length, (byte) 0);
		try {
			return "ipv6:" + InetAddress.getByAddress(prefix).getHostAddress() + "/64";
		}
		catch (UnknownHostException impossible) {
			throw new IllegalStateException("A 16-byte IPv6 prefix must be valid", impossible);
		}
	}

	private static byte[] parseIpv4(String candidate) {
		String[] octets = candidate.split("\\.", -1);
		if (octets.length != 4) {
			return null;
		}
		byte[] address = new byte[4];
		for (int index = 0; index < octets.length; index++) {
			String octet = octets[index];
			if (octet.isEmpty() || octet.length() > 3) {
				return null;
			}
			int value = 0;
			for (int characterIndex = 0; characterIndex < octet.length(); characterIndex++) {
				char character = octet.charAt(characterIndex);
				if (character < '0' || character > '9') {
					return null;
				}
				value = value * 10 + character - '0';
			}
			if (value > 255) {
				return null;
			}
			address[index] = (byte) value;
		}
		return address;
	}
}
