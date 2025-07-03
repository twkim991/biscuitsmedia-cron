const mysql = require('mysql2/promise');
const cron = require('node-cron');
const { Builder, By, Key, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const path = require('path');

// 연결 정보 설정
const dbConfig = {
	host: 'biscuitsmedia.cafe24app.com',
	user: 'bis2203',
	password: 'apfhd@4862',
	database: 'bis2203'
};

// ✅ 설정값들
const DOWNLOAD_DIR = path.resolve(__dirname, 'downloads');

const chromeOptions = new chrome.Options();
chromeOptions.setUserPreferences({
	'download.default_directory': DOWNLOAD_DIR,  // ✅ 다운로드 경로 지정
	'download.prompt_for_download': false,       // 다운로드 시 팝업 없이 자동 저장
	'directory_upgrade': true,
	'safebrowsing.enabled': true                 // 크롬의 안전 다운로드 차단 해제
});
chromeOptions.addArguments("--headless", "--disable-gpu", "--window-size=1920,1080","lang=ko_KR")
chromeOptions.addArguments('--disable-blink-features=AutomationControlled');
chromeOptions.addArguments('user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36');
chromeOptions.addArguments('--no-sandbox','--disable-dev-shm-usage','--disable-infobars','--disable-extensions','--disable-blink-features=AutomationControlled','--disable-browser-side-navigation','--disable-features=site-per-process','--lang=ko-KR',);

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function downloadpiuri() {

	const driver = await new Builder()
		.forBrowser('chrome')
		.setChromeOptions(chromeOptions)
		.build();

	try {
		const connection = await mysql.createConnection(dbConfig);
		console.log("피우리 목록 수집중...")

		// 로그인 시도
		await driver.manage().deleteAllCookies();
		await driver.get('https://piuri.com/login.php');
		await sleep(1000);

		// 로그인 폼 입력
		await driver.findElement(By.css('input[name="mb_id"]')).sendKeys('edit@biscuitsmedia.com')
		await sleep(300)
		await driver.findElement(By.css('input[name="mb_pwd"]')).sendKeys('apfhd@486')
		await sleep(300)
		await driver.executeScript('DoLogin();');
		await sleep(5000)

		// 등록현황 페이지로 이동 // 연월, 작품코드, 필명, 플랫폼명, 매출유형, 총판매부수, 총매출, 총순매출, MG차감액, 지급액, 세전실정산금액, 잔여MG, 계산일시
		await driver.get('https://cp.piuri.com/account.php');
		await sleep(2000)

		const firstTable = await driver.findElement(By.css('table.scrolltable')); // 첫 번째 테이블
		const tableRows = await firstTable.findElements(By.css('tr')); // 그 테이블의 tr들

		for (const row of tableRows) {
			const tds = await row.findElements(By.css('td.tdu1'));
			if (tds.length === 0) continue; // 헤더나 합계는 제외

			const rowData = [];
			for (const td of tds) {
				const link = await td.findElements(By.css('a'));
				if (link.length > 0) {
				const text = await link[0].getText();
				rowData.push(text);
				} else {
				const text = await td.getText();
				rowData.push(text);
				}
			}

			const title = rowData[2];
			const yearMonth = rowData[1]

			// 연월 → 날짜 변환
			const 기준일 = new Date(`${yearMonth}-01`);
			// console.log(rowData)

			// 3. 계약현황에서 정산비율 조회
			const [rows] = await connection.execute(`
				SELECT 정산비율 FROM bis2203.계약현황
				WHERE 작품명 = ?
				AND 계약일 <= ?
				AND (종료일 IS NULL OR 종료일 >= ?)
				ORDER BY 계약일 DESC
				LIMIT 1
			`, [title, 기준일, 기준일]);

			let ratio = 100; // 기본값
			if (rows.length > 0) {
				ratio = rows[0].정산비율;
			} else {
				console.warn(`정산비율 없음: ${title}, ${yearMonth}`);
			}

			const 세전실정산금액 = Number(rowData[10].replace(/,/g, '')) * (ratio / 100);
			
			const [code, name, platform, totalcount, category, totalrevenue, totalrealrevenue, realpayment] = [rowData[13], rowData[3], 'piuri', rowData[8], '0', Number(rowData[9].replace(/,/g, '')), Number(rowData[10].replace(/,/g, '')), 세전실정산금액]
			console.log(code, name, platform, totalcount, category, totalrevenue, totalrealrevenue, realpayment)

      		// MG 테이블에서 현재 MG 가져오기
			const [[mgRow]] = await connection.execute(`
				SELECT MG FROM bis2203.mg WHERE 작품코드 = ? AND 플랫폼명 = ? AND mg != 0
			`, [code, platform]);

			let beforeMG = mgRow?.MG ?? 0;
			let deductMG = 0;
			let payment = 0;
			let afterMG = 0;

			if (totalrealrevenue <= beforeMG) {
				deductMG = totalrealrevenue;
				payment = 0;
				afterMG = beforeMG - totalrealrevenue;
			} else {
				deductMG = beforeMG;
				payment = totalrealrevenue - beforeMG;
				afterMG = 0;
			}

			// 3. 월별정산내역 테이블에 저장
			await connection.execute(`
				INSERT INTO bis2203.월별정산내역 (
					연월, 작품코드, 필명, 플랫폼명, 매출유형, 총판매부수, 총매출, 총순매출, MG차감액, 지급액, 세전실정산금액, 잔여MG, 계산일시
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
			`, [
				yearMonth, code, name, platform, category, totalcount, totalrevenue, totalrealrevenue, deductMG, payment, realpayment, afterMG
			]);

			// 4. MG 테이블 업데이트
			await connection.execute(`
				UPDATE bis2203.mg SET MG = ? 
				WHERE 작품코드 = ? AND 플랫폼명 = ? AND mg != 0
			`, [afterMG, code, platform]);

			console.log(`✅ 정산 완료: ${code}, ${platform} → 총순매출: ${totalrealrevenue}, 지급: ${payment}, 잔여MG: ${afterMG}`);
		}
	} catch (e) {
		console.log(e);
	} finally {
		console.log('종료')
		await driver.quit();
	}
}

async function runMonthlySettlement() {
	console.log('📦 월별 정산 내역 계산 시작:', new Date());

	await downloadpiuri();

	try {
		const connection = await mysql.createConnection(dbConfig);

		const targetMonth = new Date();
		// targetMonth.setMonth(targetMonth.getMonth() - 1);
		targetMonth.setMonth(targetMonth.getMonth() - 1); // 저번달로 설정
		const yearMonth = targetMonth.toISOString().slice(0, 7); // 'YYYY-MM'

		// 1. 전월 매출 데이터 group by (작품코드 + 필명 + 플랫폼명 + 매출유형)
		const [revenues] = await connection.execute(`
			SELECT 
				m.작품코드,
				m.작가명 AS 필명,
				m.플랫폼명,
				m.매출유형,
				SUM(m.판매부수) AS 총판매부수,
				SUM(m.매출) AS 총매출,
				SUM(m.순매출) AS 총순매출,
				SUM(m.순매출) * (k.정산비율 / 100) AS 세전실정산금액
			FROM bis2203.매출 m
			JOIN bis2203.작품목록 w
			ON m.작품코드 = w.작품코드
			JOIN bis2203.계약현황 k
			ON w.작품명 = k.작품명
			AND m.날짜 >= k.계약일
			AND (k.종료일 IS NULL OR m.날짜 <= k.종료일)
			WHERE m.날짜 >= ? AND m.날짜 < DATE_ADD(?, INTERVAL 1 MONTH)
			GROUP BY m.작품코드, m.작가명, m.플랫폼명, m.매출유형
		`, [`${yearMonth}-01`, `${yearMonth}-01`]);

		console.log(revenues, yearMonth)

		// 2. 각 작품에 대해 MG 비교 및 정산 처리
		for (const row of revenues) {
			const code = row.작품코드;
			const name = row.필명;
			const platform = row.플랫폼명;
			const totalcount = row.총판매부수;
			const category = row.매출유형;
			const totalrevenue = row.총매출;
			const totalrealrevenue = row.총순매출;
			const realpayment = row.세전실정산금액
			console.log(code, name, platform, category, totalrevenue, totalrealrevenue, realpayment)

      		// MG 테이블에서 현재 MG 가져오기
			const [[mgRow]] = await connection.execute(`
				SELECT MG FROM bis2203.mg WHERE 작품코드 = ? AND 플랫폼명 = ? AND mg != 0
			`, [code, platform]);

			let beforeMG = mgRow?.MG ?? 0;
			let deductMG = 0;
			let payment = 0;
			let afterMG = 0;

			if (totalrealrevenue <= beforeMG) {
				deductMG = totalrealrevenue;
				payment = 0;
				afterMG = beforeMG - totalrealrevenue;
			} else {
				deductMG = beforeMG;
				payment = totalrealrevenue - beforeMG;
				afterMG = 0;
			}

			// 3. 월별정산내역 테이블에 저장
			await connection.execute(`
				INSERT INTO bis2203.월별정산내역 (
					연월, 작품코드, 필명, 플랫폼명, 매출유형, 총판매부수, 총매출, 총순매출, MG차감액, 지급액, 세전실정산금액, 잔여MG, 계산일시
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
			`, [
				yearMonth, code, name, platform, category, totalcount, totalrevenue, totalrealrevenue, deductMG, payment, realpayment, afterMG
			]);

			// 4. MG 테이블 업데이트
			await connection.execute(`
				UPDATE bis2203.mg SET MG = ? 
				WHERE 작품코드 = ? AND 플랫폼명 = ? AND mg != 0
			`, [afterMG, code, platform]);

			console.log(`✅ 정산 완료: ${code}, ${platform} → 총순매출: ${totalrealrevenue}, 지급: ${payment}, 잔여MG: ${afterMG}`);
		}

		await connection.end();
		console.log('✅ 월별 정산 프로세스 완료:', new Date());
		process.exit(0);  // 👈 Node.js 프로세스 종료

	} catch (err) {
		console.error('❌ 정산 오류:', err.message);
	}
}

cron.schedule('0 0 1 * *', runMonthlySettlement); // 매달 1일 자정에 실행

// 테스트 시점에서 수동 실행
if (require.main === module) {
	runMonthlySettlement();
}
