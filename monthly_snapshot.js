const mysql = require('mysql2/promise');
const cron = require('node-cron');

// 연결 정보 설정
const dbConfig = {
	host: 'biscuitsmedia.cafe24app.com',
	user: 'bis2203',
	password: 'apfhd@4862',
	database: 'bis2203'
};

async function runMonthlySettlement() {
	console.log('📦 월별 정산 내역 계산 시작:', new Date());

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

	} catch (err) {
		console.error('❌ 정산 오류:', err.message);
	}
  }
  
  cron.schedule('0 0 1 * *', runMonthlySettlement); // 매달 1일 자정에 실행
  
  // 테스트 시점에서 수동 실행
  if (require.main === module) {
	runMonthlySettlement();
  }
