/**
 * Test bộ nhớ liên phiên.
 *
 * Trọng tâm là những chỗ có thể BÁO XANH TRONG KHI SAI:
 *   · tệp thiếu description → recall không bao giờ chọn được, nhưng vẫn nằm đó
 *   · nội dung tệp lọt vào system prompt (mất hết lợi ích tiết lộ tiệm tiến)
 *   · "bỏ qua bộ nhớ" nhưng prompt vẫn còn nội dung
 *   · chuỗi tuổi tính lại mỗi lượt → vỡ KV-cache mà không ai nhận ra
 */

import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { thuNhac } from "../src/attachments/index";
import {
	MAX_BYTE_CA_PHIEN,
	MAX_BYTE_MOI_TEP,
	MAX_TEP_MOI_LUOT,
	MEMORY_SECTION,
	type TepBoNho,
	chonLienQuan,
	chuoiTuoi,
	docNoiDung,
	installMemory,
	memoryDir,
	nguonBoNhoLienQuan,
	quetBoNho,
	summarizeMemoryReport,
	tachTu,
} from "../src/memory/index";

const root = join(tmpdir(), `agentweave-memory-${Date.now()}`);
const duAn = join(root, "duan");
const NGAY = 86_400_000;
const T0 = 1_800_000_000_000;

async function ghiBoNho(ten: string, fm: string, than: string, tuoiNgay = 0): Promise<string> {
	const dir = memoryDir(duAn);
	await mkdir(dir, { recursive: true });
	const duong = join(dir, ten);
	await writeFile(duong, `---\n${fm}\n---\n\n${than}\n`);
	if (tuoiNgay > 0) {
		const t = new Date(T0 - tuoiNgay * NGAY);
		await utimes(duong, t, t);
	}
	return duong;
}

beforeAll(async () => {
	await mkdir(duAn, { recursive: true });
	await ghiBoNho(
		"thich-tieng-viet.md",
		"name: thich-tieng-viet\ndescription: nguoi dung muon moi giai thich viet bang tieng Viet\ntype: user",
		"Tra loi bang tieng Viet.",
		2,
	);
	await ghiBoNho(
		"jetson-cham.md",
		"name: jetson-cham\ndescription: build docker tren Jetson rat cham, dung buildx cache\ntype: project",
		"Build tren Jetson mat 40 phut neu khong cache.\n**Why:** ARM64 phai bien dich lai.\n**How to apply:** luon bat buildx cache.",
		5,
	);
	await ghiBoNho(
		"khong-tu-commit.md",
		"name: khong-tu-commit\ndescription: khong duoc tu dong commit hay push khi chua hoi\ntype: feedback",
		"Khong commit khi chua hoi.\n**Why:** ho review truoc khi vao lich su.\n**How to apply:** hoi truoc moi lan commit.",
		60,
	);
	await writeFile(
		join(memoryDir(duAn), "MEMORY.md"),
		"- [Tieng Viet](thich-tieng-viet.md) — ngon ngu tra loi\n- [Jetson cham](jetson-cham.md) — build ARM64\n",
	);
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("quetBoNho", () => {
	it("doc duoc 3 tep hop le kem loai va mo ta", async () => {
		const rp = await quetBoNho(duAn);
		expect(rp.tep).toHaveLength(3);
		expect(rp.tep.map((t) => t.loai).sort()).toEqual(["feedback", "project", "user"]);
		expect(rp.problems).toEqual([]);
	});

	it("MEMORY.md KHONG bi tinh la mot bo nho", async () => {
		const rp = await quetBoNho(duAn);
		expect(rp.tep.map((t) => t.ten)).not.toContain("MEMORY.md");
		expect(rp.chiMuc).toContain("Tieng Viet");
	});

	it("thu muc chua ton tai KHONG phai loi", async () => {
		const rp = await quetBoNho(join(root, "chua-co"));
		expect(rp.tep).toEqual([]);
		expect(rp.problems).toEqual([]);
		expect(rp.dir).toBeNull();
	});

	it("thieu description → BO va bao loi, vi recall khong bao gio chon duoc", async () => {
		const rieng = join(root, "thieu-mota");
		await mkdir(memoryDir(rieng), { recursive: true });
		await writeFile(join(memoryDir(rieng), "x.md"), "---\nname: x\ntype: user\n---\nnoi dung");
		const rp = await quetBoNho(rieng);
		expect(rp.tep).toEqual([]);
		expect(rp.problems[0]?.kind).toBe("thieu_mo_ta");
		expect(rp.problems[0]?.fatal).toBe(true);
	});

	it("loai la nghia — bon loai co y hep, them loai thu nam la mo duong cho bai rac", async () => {
		const rieng = join(root, "loai-la");
		await mkdir(memoryDir(rieng), { recursive: true });
		await writeFile(
			join(memoryDir(rieng), "y.md"),
			"---\nname: y\ndescription: d\ntype: linh-tinh\n---\nz",
		);
		const rp = await quetBoNho(rieng);
		expect(rp.problems[0]?.kind).toBe("loai_khong_hop_le");
	});

	it("thieu frontmatter → bo, khong doan bua", async () => {
		const rieng = join(root, "khong-fm");
		await mkdir(memoryDir(rieng), { recursive: true });
		await writeFile(join(memoryDir(rieng), "z.md"), "chi la van xuoi");
		const rp = await quetBoNho(rieng);
		expect(rp.problems[0]?.kind).toBe("thieu_frontmatter");
	});
});

describe("recall tat dinh", () => {
	let tep: TepBoNho[];
	beforeAll(async () => {
		tep = [...(await quetBoNho(duAn)).tep];
	});

	it("chon dung tep theo tu khoa trong cau hoi", () => {
		const kq = chonLienQuan("build docker tren jetson sao cham the", tep, T0, 3);
		expect(kq[0]?.tep.ten).toBe("jetson-cham.md");
		// Giai thich duoc: chi ra dung tu nao khop.
		expect(kq[0]?.tuKhop).toContain("jetson");
	});

	it("cau hoi khong lien quan thi KHONG bom gi — tha thieu con hon bom nham", () => {
		expect(chonLienQuan("hom nay troi dep qua", tep, T0, 3)).toEqual([]);
		expect(chonLienQuan("", tep, T0, 3)).toEqual([]);
	});

	it("ton trong so tep toi da", () => {
		const kq = chonLienQuan("tieng viet jetson commit build docker", tep, T0, 1);
		expect(kq).toHaveLength(1);
	});

	it("tu pho bien khong keo diem — trong so hiem lam viec", () => {
		const gia: TepBoNho[] = Array.from({ length: 5 }, (_, i) => ({
			ten: `t${i}.md`,
			duong: `/x/t${i}.md`,
			loai: "project" as const,
			moTa: "du an nay dung docker",
			nhan: `t${i}`,
			mtimeMs: T0 - 100 * NGAY,
			bytes: 10,
		}));
		gia.push({
			ten: "hiem.md",
			duong: "/x/hiem.md",
			loai: "project",
			moTa: "cau hinh bubblewrap cho sandbox",
			nhan: "hiem",
			mtimeMs: T0 - 100 * NGAY,
			bytes: 10,
		});
		const kq = chonLienQuan("docker bubblewrap", gia, T0, 3);
		expect(kq[0]?.tep.ten).toBe("hiem.md");
	});

	it("tep moi sua duoc thuong diem", () => {
		const cu: TepBoNho = {
			ten: "cu.md",
			duong: "/x/cu.md",
			loai: "project",
			moTa: "quy uoc dat ten bien",
			nhan: "cu",
			mtimeMs: T0 - 300 * NGAY,
			bytes: 10,
		};
		const moi: TepBoNho = { ...cu, ten: "moi.md", duong: "/x/moi.md", mtimeMs: T0 - 1 * NGAY };
		const kq = chonLienQuan("quy uoc dat ten bien", [cu, moi], T0, 2);
		expect(kq[0]?.tep.ten).toBe("moi.md");
	});

	it("tachTu bo tu dung va tu qua ngan", () => {
		expect(tachTu("va la cua docker")).toEqual(["docker"]);
		expect(tachTu("the a of docker")).toEqual(["docker"]);
	});
});

describe("chuoiTuoi — dong bang de khong vo KV-cache", () => {
	it("dien dat theo ngay/thang", () => {
		expect(chuoiTuoi(T0, T0)).toBe("saved today");
		expect(chuoiTuoi(T0 - NGAY, T0)).toBe("saved yesterday");
		expect(chuoiTuoi(T0 - 3 * NGAY, T0)).toBe("saved 3 days ago");
		expect(chuoiTuoi(T0 - 65 * NGAY, T0)).toBe("saved about 2 months ago");
	});

	it("cung mtime + cung moc thoi gian → CUNG chuoi, khong phu thuoc luc goi", () => {
		// Neu tinh lai moi luot thi "3 days ago" thanh "4 days ago" → khac byte
		// → prefix doi → Jetson phai prefill lai toan bo. Phai dong bang mot lan.
		expect(chuoiTuoi(T0 - 3 * NGAY, T0)).toBe(chuoiTuoi(T0 - 3 * NGAY, T0));
	});
});

describe("docNoiDung", () => {
	it("cat theo tran VA chi duong toi tep day du", async () => {
		const duong = await ghiBoNho(
			"dai.md",
			"name: dai\ndescription: mot bo nho rat dai\ntype: project",
			"L".repeat(5_000),
		);
		const rp = await quetBoNho(duAn);
		const t = rp.tep.find((x) => x.ten === "dai.md")!;
		const noi = await docNoiDung(t, 500);
		expect(noi.length).toBeLessThan(1_200);
		expect(noi).toContain("FileRead");
		expect(noi).toContain(duong);
		await rm(duong);
	});
});

describe("installMemory", () => {
	it("dat cach dung + chi muc vao prompt, NHUNG khong dat noi dung tep", async () => {
		const daDat: Array<[string, string | null]> = [];
		await installMemory(
			{ setSystemPromptSection: (n, c) => daDat.push([n, c]) },
			{ projectDir: duAn, quiet: true },
		);
		const muc = daDat[0]![1]!;
		expect(daDat[0]![0]).toBe(MEMORY_SECTION);
		expect(muc).toContain("Before recommending from memory");
		expect(muc).toContain("thich-tieng-viet.md"); // dong chi muc
		// Noi dung tep KHONG duoc vao prompt — mat het loi ich tiet lo tiem tien.
		expect(muc).not.toContain("Tra loi bang tieng Viet.");
	});

	it("bon muc prompt eval-validated deu co mat", async () => {
		const daDat: Array<[string, string | null]> = [];
		await installMemory(
			{ setSystemPromptSection: (n, c) => daDat.push([n, c]) },
			{ projectDir: duAn, quiet: true },
		);
		const muc = daDat[0]![1]!;
		expect(muc).toContain("What NOT to save");
		expect(muc).toContain("even when the user explicitly tells you to save");
		expect(muc).toContain("Before recommending from memory");
		expect(muc).toContain("If the user says to ignore memory");
	});

	it("boQua → prompt RONG HAN, khong phai dat vao roi dan dung dung", async () => {
		const daDat: Array<[string, string | null]> = [];
		const kq = await installMemory(
			{ setSystemPromptSection: (n, c) => daDat.push([n, c]) },
			{ projectDir: duAn, quiet: true, boQua: true },
		);
		expect(kq.daBat).toBe(false);
		expect(daDat[0]).toEqual([MEMORY_SECTION, null]);
	});

	it("chua co tep nho nao thi day bang ban LUOI — van du de ghi mau dau tien", async () => {
		// Huong dan day du la ~711 token nam thuong truc MOI luot. Tra gia do cho
		// mot thu muc rong la vi pham chinh nguyen tac tiet lo tiem tien cua no.
		const daDat: Array<[string, string | null]> = [];
		await installMemory(
			{ setSystemPromptSection: (n, c) => daDat.push([n, c]) },
			{ projectDir: join(root, "chua-co"), quiet: true },
		);
		const muc = daDat[0]![1]!;
		expect(muc).toContain("Memory");
		expect(muc).toContain("EMPTY");
		// Van phai du de tao dung khuon: frontmatter + mot dong vao chi muc.
		expect(muc).toContain("description");
		expect(muc).toContain("MEMORY.md");
		// Va phai NGAN. Ban day du dai 2.845 byte.
		expect(muc.length).toBeLessThan(600);
	});

	it("summarizeMemoryReport du so lieu cho bo tu kiem tra", async () => {
		const rp = await quetBoNho(duAn);
		expect(summarizeMemoryReport(rp)).toMatch(/\d+ bo nho · chi muc \d+ byte/);
	});
});

describe("nguonBoNhoLienQuan", () => {
	async function nguon() {
		return nguonBoNhoLienQuan(await quetBoNho(duAn), () => T0);
	}

	it("bom tep khop voi cau hoi", async () => {
		const kq = await thuNhac([await nguon()], {
			luot: 1,
			fileVuaCham: [],
			daBom: new Set(),
			promptNguoiDung: "vi sao build docker tren jetson cham",
			byteBoNhoDaBom: 0,
		});
		expect(kq.nhac).toHaveLength(1);
		expect(kq.nhac[0]?.noiDung).toContain("Build tren Jetson");
		// Cau canh bao kiem chung phai di kem moi lan bom.
		expect(kq.nhac[0]?.noiDung).toContain("verify anything that names a file");
	});

	it("cau hoi rong hoac khong lien quan thi khong bom gi", async () => {
		const n = await nguon();
		for (const p of ["", "hom nay troi dep"]) {
			const kq = await thuNhac([n], {
				luot: 1,
				fileVuaCham: [],
				daBom: new Set(),
				promptNguoiDung: p,
				byteBoNhoDaBom: 0,
			});
			expect(kq.nhac).toEqual([]);
		}
	});

	it("cham tran ca phien thi dung bom", async () => {
		const kq = await thuNhac([await nguon()], {
			luot: 9,
			fileVuaCham: [],
			daBom: new Set(),
			promptNguoiDung: "jetson docker build",
			byteBoNhoDaBom: MAX_BYTE_CA_PHIEN,
		});
		expect(kq.nhac).toEqual([]);
	});

	it("KHONG dat khoa — cau hoi sau van bom lai duoc sau khi nen xoa khoi cu", async () => {
		const kq = await thuNhac([await nguon()], {
			luot: 1,
			fileVuaCham: [],
			daBom: new Set(),
			promptNguoiDung: "jetson docker",
			byteBoNhoDaBom: 0,
		});
		expect(kq.nhac[0]?.khoa).toBeUndefined();
	});

	it("ngan sach 64K: tran phien 20KB, moi tep 2KB, toi da 3 tep mot luot", () => {
		expect(MAX_BYTE_CA_PHIEN).toBe(20_480);
		expect(MAX_BYTE_MOI_TEP).toBe(2_048);
		expect(MAX_TEP_MOI_LUOT).toBe(3);
	});
});
