import axios from 'axios';
import { EXTERNAL_API_TIMEOUT, MILLION_VERIFIER_API_KEY, TRYKITT_API_KEY } from './config.ts';

export async function verifyEmail(email: string): Promise<any> {
    try {
        const response = await axios.get(`https://api.millionverifier.com/api/v3/?api=${MILLION_VERIFIER_API_KEY}`, {
            params: {
                email: email,
                api_key: MILLION_VERIFIER_API_KEY
            },
            timeout: EXTERNAL_API_TIMEOUT
        });
        return response.data;
    } catch (error) {
        console.error(`Error verifying email ${email}:`, error);
        throw error;
    }
}

export async function verifyEmailWithTryKitt(email: string): Promise<any> {
    try {
        const response = await axios.post('https://api.trykitt.ai/job/verify_email', {
            email: email,
            customData: "myInternalId",
            callbackURL: "only_used_if_realtime_param_is_false",
            realtime: true,
            treatAliasesAsValid: true
        }, {
            headers: {
                'x-api-key': TRYKITT_API_KEY,
                'Content-Type': 'application/json'
            },
            timeout: EXTERNAL_API_TIMEOUT
        });
        return response.data;
    } catch (error) {
        console.error(`Error verifying email with TryKitt ${email}:`, error);
        throw error;
    }
}

export async function resolveMxRecord(domain: string): Promise<any> {
    const apiUrl = `https://dns.google/resolve?name=${domain}&type=MX`;
    const response = await axios.get(apiUrl, {
        timeout: EXTERNAL_API_TIMEOUT
    });
    return response.data;
}
