/**
 * Ống dẫn attachment — điểm vào duy nhất.
 *
 * Xem `types.ts` để hiểu vì sao tách khỏi `agent-loop.ts`.
 */

export { thuNhac, bocNhacHeThong, nhacGuard, locNhacGuard, NHAN_NHAC_GUARD } from "./thu-thap";
export { NhipNhac, type MucNhac, type CauHinhNhip } from "./nhip-nhac";
export { TIMEOUT_THU_NHAC } from "./types";
export type { Nhac, NguonNhac, BoiCanhLuot, KetQuaThuNhac } from "./types";
