// 📦 자동화 파이프라인: 크롤링 → 다운로드 → 파싱 → DB 저장

const { Builder, By, Key, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const xlsx = require('xlsx');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const csv = require('csv-parser');
const iconv = require('iconv-lite');
let TODAY = new Date();
const bomtoon_codes = {};
// const codeMap = {
// 			'예비 매형의 닫히지 않는 구멍': 'noru0527_2',
// 			'몽마인데요, 상대를 잘못 고른 것 같습니다. 살려_아앙_': 'noru0527',
// 			'올리비아는 이미 나쁜 짓을 저질렀다': 'ggul0530',
// 			'조직의 공주님': '22_0530',
// 			'명예혁명': 'van20250519',
// 			'초콜릿이 먹고 싶었을 뿐인데': 'rir20250520',
// 		};

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

// 연결 정보 설정
const dbConfig = {
	host: 'biscuitsmedia.cafe24app.com',
	user: 'bis2203',
	password: 'apfhd@4862',
	database: 'bis2203'
};

// 📅 어제 날짜 구하기
function getYesterday(count, format = 'file') {
	const d = new Date();
	console.log(d)
	d.setDate(d.getDate() - count); // ← 어제 날짜
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	const dd = String(d.getDate()).padStart(2, '0');
	return format === 'file' ? `${yyyy}-${mm}-${dd}` : `${yyyy}${mm}${dd}`;
}

function toKST(utc) {
  const utcDate = new Date(utc);
  const kstDate = new Date(utcDate.getTime() + 9 * 60 * 60 * 1000); // +9시간

  const year = kstDate.getFullYear();
  const month = String(kstDate.getMonth() + 1).padStart(2, '0'); // 0부터 시작
  const day = String(kstDate.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

// // 시리즈는 contentsSelling_2025-04-04
// // 카카오는 시리즈일매출통계-2025-03-01
// // 리디는 calculate_date_2025-04-04_2025-04-04
// // 정산액 계산할때 조아라와 봄툰은 40퍼, 나머지는 30퍼 까고 들어감 리디는 자체적으로 계산돼서 정산액이 들어옴

function renameDownloadedFile(beforeName, platform, date) {
	const oldPath = path.join(DOWNLOAD_DIR, beforeName);
	const ext = path.extname(beforeName);
	const newFileName = `${platform}_${date}${ext}`;
	const newPath = path.join(DOWNLOAD_DIR, newFileName);
	
	// 파일 이름 변경
	fs.renameSync(oldPath, newPath);

	return newPath;
}

// alert 처리
async function handleAlert(driver) {
	try {
		await driver.wait(until.alertIsPresent(), 1000); // 최대 1초 대기
		const alert = await driver.switchTo().alert();
		console.log('⚠️ Alert 감지됨:', await alert.getText());
		await alert.accept(); // 또는 alert.dismiss()
		await sleep(500); // alert 처리 후 잠깐 대기
	} catch (err) {
		// alert이 없으면 무시
		if (!err.name.includes('TimeoutError')) {
			console.error('⚠️ Alert 처리 중 오류:', err);
		}
	}
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function unzipAndRename(zipDir, zipName, newName) {
	const zipPath = path.join(zipDir, zipName);

	// 압축 파일 존재 확인
	if (!fs.existsSync(zipPath)) {
		console.error('❌ 압축 파일이 존재하지 않습니다:', zipPath);
		return;
	}

	const zip = new AdmZip(zipPath);
	const zipEntries = zip.getEntries().find(entry => entry.entryName.endsWith('.csv'));

	// 압축 해제 (파일명은 newXlsxName으로 지정)
	const outputPath = path.join(zipDir, newName);
	fs.writeFileSync(outputPath, zipEntries.getData());
	fs.unlinkSync(zipPath);
	console.log('✅ 압축 해제 및 이름 변경 완료:', outputPath);

	return outputPath;
}

function parseExcel(Platform, yesterday) {
	return new Promise(async(resolve, reject) => {
		if(Platform == 'series') {
			// 파일이 제대로 다운로드 되어있는지 확인
			const expectedFileName = `contentsSelling_${getYesterday(0, 'file')}`;
			console.log(expectedFileName)
			const matchedFile = fs.readdirSync(DOWNLOAD_DIR).find(name => name.startsWith(expectedFileName));
			if (!matchedFile) {
				console.log(`❌${expectedFileName}이 없습니다. 다운로드 실패로 간주합니다.`);
				resolve([]);
				return;
			}

			// 파일 이름을 platform_YYYY-MM-DD 꼴로 변경
			const filePath = renameDownloadedFile(matchedFile, Platform, yesterday);
			console.log(filePath)

			const workbook = xlsx.readFile(filePath);
			const sheetName = workbook.SheetNames[1];
			const sheet = workbook.Sheets[sheetName];
			const rows = xlsx.utils.sheet_to_json(sheet, { defval: '', header: 1 });

			const data = [];
			rows.forEach(function(row,idx,arr){
				if(idx == 0 || idx == 1 || idx == arr.length-1 ) {return;}
				// 결과를 저장할 배열과 변수
				let content_no = 0;
				let name = '';
				let totalSalesCount = 0;
				let totalRevenue = 0;
				content_no = row[1];
				name = row[4];
				totalSalesCount = row[29] + row[35] + row[41] + row[47] + row[53] + row[59] + row[65];
				totalRevenue = row[row.length-1] - row[row.length-2];
				// console.log(row)
				data.push([ content_no, name, totalSalesCount, totalRevenue, totalRevenue*0.7 ])
			});
			console.log('파일 파싱 완료');
			fs.unlinkSync(filePath);
			resolve(data);

		}else if(Platform == 'kakao') {
			// 파일이 제대로 다운로드 되어있는지 확인
			const expectedFileName = `시리즈일매출통계-${yesterday}`;
			const matchedFile = fs.readdirSync(DOWNLOAD_DIR).find(name => name.startsWith(expectedFileName));
			if (!matchedFile) {
				console.log(`❌${expectedFileName}이 없습니다. 다운로드 실패로 간주합니다.`);
				resolve([]);
				return;
			}

			// 파일 이름을 platform_YYYY-MM-DD 꼴로 변경
			const filePath = renameDownloadedFile(matchedFile, Platform, yesterday);
			console.log(filePath)

			const db = await mysql.createConnection(dbConfig); // DB 연결
			const fileContent = fs.readFileSync(filePath, { encoding: 'utf8' }); // or 'utf-8-sig'
			const workbook = xlsx.read(fileContent, { type: 'string' });
			const sheet = workbook.Sheets[workbook.SheetNames[0]];
			// console.log(sheet)
			const rows = xlsx.utils.sheet_to_json(sheet, { defval: '', header: 1 });
			const data = [];

			for (let idx = 0; idx < rows.length; idx++) {
				const row = rows[idx];
				if (idx === 0 || idx === rows.length - 1) continue;

				let content_no = row[1];
				let name = row[5];
				let totalSalesCount = row[32];
				let totalRevenue = row[row.length - 1];

				// 기본 수수료 30%
				let charge = 30;

				try {
					const [rows2] = await db.execute(`
						SELECT 수수료 FROM bis2203.카카오수수료
						WHERE 작품코드 = ?
						AND 계약일 <= DATE(?)
						AND (종료일 IS NULL OR 종료일 >= DATE(?))
						ORDER BY 계약일 DESC
						LIMIT 1
					`, [content_no, yesterday, yesterday]);

					if (rows2.length > 0) charge = rows2[0].수수료;
				} catch (err) {
					console.error('❌ 수수료 조회 실패:', err.message);
				}

				const settlement = totalRevenue * (100 - charge) / 100;
				data.push([content_no, name, totalSalesCount, totalRevenue, settlement]);
			}

			await db.end();
			fs.unlinkSync(filePath);
			console.log('파일 파싱 완료');
			resolve(data);
		}else if(Platform == 'ridi') {
			// 파일이 제대로 다운로드 되어있는지 확인
			const realday = yesterday.replace(/-/g, '');
			const expectedFileName = `calculate_date_${realday}_${realday}`;
			const matchedFile = fs.readdirSync(DOWNLOAD_DIR).find(name => name.startsWith(expectedFileName));
			if (!matchedFile) {
				console.log(`❌${expectedFileName}이 없습니다. 다운로드 실패로 간주합니다.`);
				resolve([]);
				return;
			}

			const filePath = unzipAndRename(DOWNLOAD_DIR, `${expectedFileName}.zip`, `${Platform}_${yesterday}.csv`);

			

			// 파일 이름을 platform_YYYY-MM-DD 꼴로 변경
			// console.log(filePath)
			let content_no = 0;
			let name = '';
			let totalSalesCount = 0;
			let totalRevenue = 0;
			const data = [];

			// // CSV를 엑셀 시트처럼 읽기 (encoding은 내부에서 auto)
			// const workbook = xlsx.readFile(filePath, { type: 'file' });
			// const sheet = workbook.Sheets[workbook.SheetNames[0]];

			// // 2행 G열은 엑셀 기준으로 'G2'
			// content_no = sheet['C2']
			// const cell = sheet['G2'].f;
			// name = cell.match(/T\("(.*)"\)/)[1];

			// return data;
			const stream = fs.createReadStream(filePath)
			
			stream.on('error', (err) => {
				console.error(err.message);
			});
			
			stream
			.pipe(csv())
			.on('data', (row) => {
				// 수식 컬럼만 출력
				content_no = row['도서 ID'] || 0;
				const cell = row['저자'] || '';
				name = cell.match(/T\("(.*)"\)/)[1];
				totalSalesCount = row['판매권'] || 0;
				totalCancell = row['취소권'] || 0;
				totalRevenue = row['판매액'] || 0;
				totalCancellrevenue = row['취소액'] || 0;
				totalSettlement = row['정산액'] || 0;
				data.push([Number(content_no), name, Number(totalSalesCount) - Number(totalCancell), Number(totalRevenue) - Number(totalCancellrevenue), Number(totalSettlement)]);
			})
			.on('end', () => {
				console.log('CSV 파일 파싱 완료');
				fs.unlinkSync(filePath);
				resolve(data); // 결과 리턴
				
			})
			.on('error', (err) => {
				console.error(err.message)
			});
			
		}else if(Platform == 'kyobo') {
			// 파일이 제대로 다운로드 되어있는지 확인
			const expectedFileName = `판매내역조회`;
			const matchedFile = fs.readdirSync(DOWNLOAD_DIR).find(name => name.startsWith(expectedFileName));
			if (!matchedFile) {
				console.log(`❌${expectedFileName}이 없습니다. 다운로드 실패로 간주합니다.`);
				resolve([]);
				return;
			}

			// 파일 이름을 platform_YYYY-MM-DD 꼴로 변경
			const filePath = renameDownloadedFile(matchedFile, Platform, yesterday);
			console.log(filePath)

			const workbook = xlsx.readFile(filePath);
			const sheetName = workbook.SheetNames[0];
			const sheet = workbook.Sheets[sheetName];
			const rows = xlsx.utils.sheet_to_json(sheet, { defval: '', header: 1 });
			const data = [];

			rows.forEach(function(row,idx,arr){
				// 결과를 저장할 배열과 변수
				// console.log(row)
				let content_no = 0;
				let name = '';
				let totalSalesCount = 0;
				let totalRevenue = 0;
				if(idx < 3 ) {return;}
				content_no = row[13];
				name = row[6];
				totalSalesCount = row[10];
				totalRevenue = row[11]
				data.push([ content_no, name, totalSalesCount, totalRevenue, totalRevenue*0.7 ])
			})
			console.log('파일 파싱 완료');

			// 중복되는 값들을 하나로 합치는 과정 추가
			const finalMap = new Map();

			data.forEach(row => {
				const [content_no, name, count, revenue, payout] = row;
				const key = `${content_no}::${name}`;

				if (!finalMap.has(key)) {
					finalMap.set(key, [content_no, name, 0, 0, 0]); // 초기값 설정
				}

				const entry = finalMap.get(key);
				entry[2] += Number(count);     // 총 판매수 합산
				entry[3] += Number(revenue);   // 총 매출 합산
				entry[4] += Number(payout);    // 총 정산금액 합산
			});

			const finaldata = Array.from(finalMap.values());
			// console.log(finaldata);


			fs.unlinkSync(filePath);
			resolve(finaldata);
		}else if(Platform == 'aladin') {
			// 파일이 제대로 다운로드 되어있는지 확인
			const expectedFileName = `sales_`;
			const matchedFile = fs.readdirSync(DOWNLOAD_DIR).find(name => name.startsWith(expectedFileName));
			if (!matchedFile) {
				console.log(`❌${expectedFileName}이 없습니다. 다운로드 실패로 간주합니다.`);
				resolve([]);
				return;
			}

			// 파일 이름을 platform_YYYY-MM-DD 꼴로 변경
			const filePath = renameDownloadedFile(matchedFile, Platform, yesterday);
			console.log(filePath)

			// 💡 파일을 Buffer로 읽고, cp949 → utf8로 변환
			const fileBuffer = fs.readFileSync(filePath);
			const decodedContent = iconv.decode(fileBuffer, 'cp949'); // 또는 'euc-kr'

			// 📘 CSV 내용을 엑셀로 읽기
			const workbook = xlsx.read(decodedContent, { type: 'string' });
			const sheet = workbook.Sheets[workbook.SheetNames[0]];
			const rows = xlsx.utils.sheet_to_json(sheet, { defval: '', header: 1 });
			const data = [];

			rows.forEach(function(row,idx,arr){
				// 결과를 저장할 배열과 변수
				// console.log(row)
				let content_no = 0;
				let name = '';
				let totalSalesCount = 0;
				let totalRevenue = 0;
				if(idx == 0 ) {return;}
				content_no = row[1];
				name = row[8];
				totalRevenue = row[5]
				data.push([ content_no, name, totalSalesCount, totalRevenue ])
			})

			// 판매부수가 안나오므로 다 더해서 판매부수 계산하는 과정 추가
			const groupedMap = new Map();
			for (const [content_no, name, sales, revenue] of data) {
				const key = `${content_no}::`;
				if (!groupedMap.has(key)) {
					groupedMap.set(key, {content_no,name,totalSalesCount: revenue >= 0 ? 1 : -1,totalRevenue: revenue});
				} else {
					const entry = groupedMap.get(key);
					entry.totalSalesCount += revenue >= 0 ? 1 : -1;
					entry.totalRevenue += revenue;
				}
			}

			const groupedData = Array.from(groupedMap.values());
			const finalData = groupedData.map(d => [d.content_no, d.name, d.totalSalesCount, d.totalRevenue, d.totalRevenue*0.7]);
			console.log('파일 파싱 완료');
			fs.unlinkSync(filePath);
			resolve(finalData);
		}else if(Platform == 'blice') {
			// 파일이 제대로 다운로드 되어있는지 확인
			const expectedFileName = `판매현황${getYesterday(0, 'date')}`;
			const matchedFile = fs.readdirSync(DOWNLOAD_DIR).find(name => name.startsWith(expectedFileName));
			if (!matchedFile) {
				console.log(`❌${expectedFileName}이 없습니다. 다운로드 실패로 간주합니다.`);
				resolve([]);
				return;
			}

			// 파일 이름을 platform_YYYY-MM-DD 꼴로 변경
			const filePath = renameDownloadedFile(matchedFile, Platform, yesterday);
			console.log(filePath)

			const workbook = xlsx.readFile(filePath);
			const sheetName = workbook.SheetNames[0];
			const sheet = workbook.Sheets[sheetName];
			const rows = xlsx.utils.sheet_to_json(sheet, { defval: '', header: 1 });
			const data = [];

			rows.forEach(function(row,idx,arr){
				// 결과를 저장할 배열과 변수
				// console.log(row)
				let content_no = 0;
				let name = '';
				let totalSalesCount = 0;
				let totalRevenue = 0;
				if(idx < 2 || row[0] == '조회한 결과가 없습니다.') {return;}
				content_no = row[5];
				name = row[7];
				totalSalesCount = row[8]/100;
				totalRevenue = row[8];
				data.push([ content_no, name, totalSalesCount, totalRevenue, totalRevenue*0.7 ])
			})
			console.log('파일 파싱 완료');

			fs.unlinkSync(filePath);
			resolve(data);
		}else if(Platform == 'yes24') {
			// 파일이 제대로 다운로드 되어있는지 확인
			const expectedFileName = `B2C_List`;
			const matchedFile = fs.readdirSync(DOWNLOAD_DIR).find(name => name.startsWith(expectedFileName));
			if (!matchedFile) {
				console.log(`❌${expectedFileName}이 없습니다. 다운로드 실패로 간주합니다.`);
				resolve([]);
				return;
			}

			// 파일 이름을 platform_YYYY-MM-DD 꼴로 변경
			const filePath = renameDownloadedFile(matchedFile, Platform, yesterday);
			console.log(filePath)

			const workbook = xlsx.readFile(filePath);
			const sheetName = workbook.SheetNames[0];
			const sheet = workbook.Sheets[sheetName];
			const rows = xlsx.utils.sheet_to_json(sheet, { defval: '', header: 1 });
			const data = [];

			rows.forEach(function(row,idx,arr){
				// 결과를 저장할 배열과 변수
				// console.log(row)
				let content_no = 0;
				let name = '';
				let totalSalesCount = 0;
				let totalRevenue = 0;
				if(idx == 0 ) {return;}
				content_no = row[14];
				name = row[12];
				if(row[19] == '') { totalSalesCount = 1}
				else {totalSalesCount = -1}
				totalRevenue = row[3];
				data.push([ content_no, name, totalSalesCount, totalRevenue, totalRevenue*0.7 ])
			})

			// 판매부수가 안나오므로 다 더해서 판매부수 계산하는 과정 추가
			const groupedMap = new Map();
			for (const [content_no, name, sales, revenue] of data) {
				const key = `${content_no}::`;
				if (!groupedMap.has(key)) {
					groupedMap.set(key, {content_no,name,totalSalesCount: sales,totalRevenue: Number(revenue)*sales});
				} else {
					const entry = groupedMap.get(key);
					entry.totalSalesCount += sales;	
					entry.totalRevenue += Number(revenue)*sales;
				}
			}

			const groupedData = Array.from(groupedMap.values());
			const finalData = groupedData.map(d => [d.content_no, d.name, d.totalSalesCount, d.totalRevenue, d.totalRevenue*0.7]);
			console.log('파일 파싱 완료');
			fs.unlinkSync(filePath);
			resolve(finalData);
		}else if(Platform == 'bomtoon') {
			// 파일이 제대로 다운로드 되어있는지 확인
			const expectedFileName = `기간별 회차통계.xlsx`;
			const matchedFile = fs.readdirSync(DOWNLOAD_DIR).find(name => name.endsWith(expectedFileName));
			if (!matchedFile) {
				console.log(`❌${expectedFileName}이 없습니다. 다운로드 실패로 간주합니다.`);
				resolve([]);
				return;
			}

			// 파일 이름을 platform_YYYY-MM-DD 꼴로 변경
			const filePath = renameDownloadedFile(matchedFile, Platform, yesterday);
			console.log(filePath)

			const workbook = xlsx.readFile(filePath);
			const sheetName = workbook.SheetNames[0];
			const sheet = workbook.Sheets[sheetName];
			const rows = xlsx.utils.sheet_to_json(sheet, { defval: '', header: 1 });
			const data = [];

			rows.forEach(function(row,idx,arr){
				// 결과를 저장할 배열과 변수
				// console.log(row)
				let content_no = 0;
				let name = '';
				let totalSalesCount = 0;
				let totalRevenue = 0;
				if(idx == 0 || row[13] == 0) {return;}
				content_no = bomtoon_codes[row[0]];
				totalSalesCount = row[13]
				totalRevenue = row[13] * 180;
				data.push([ content_no, name, totalSalesCount, totalRevenue, totalRevenue*0.6 ])
			})
			console.log('파일 파싱 완료');
			// 중복되는 값들을 하나로 합치는 과정 추가
			// console.log(data)
			const finalMap = new Map();

			data.forEach(row => {
				const [content_no, name, count, revenue, payout] = row;
				// console.log(row)
				const key = `${content_no}::${name}`;

				if (!finalMap.has(key)) {
					finalMap.set(key, [content_no, name, 0, 0, 0]); // 초기값 설정
				}

				const entry = finalMap.get(key);
				entry[2] += Number(count);     // 총 판매수 합산
				entry[3] += Number(revenue);   // 총 매출 합산
				entry[4] += Number(payout);    // 총 정산금액 합산
			});

			const finaldata = Array.from(finalMap.values());
			// console.log(finaldata);


			fs.unlinkSync(filePath);
			resolve(finaldata);
		}else if(Platform == 'bookcube') {
			// 파일이 제대로 다운로드 되어있는지 확인
			const expectedFileName2 = `도서 등록 현황`;
			const matchedFile2 = fs.readdirSync(DOWNLOAD_DIR).find(name => name.startsWith(expectedFileName2));
			if (!matchedFile2) {
				console.log(`❌${expectedFileName2}이 없습니다. 다운로드 실패로 간주합니다.`);
				resolve([]);
				return;
			}

			// 파일 이름을 platform_YYYY-MM-DD 꼴로 변경
			const filePath2 = renameDownloadedFile(matchedFile2, Platform, yesterday);
			console.log(filePath2)

			const workbook2 = xlsx.readFile(filePath2);
			const sheetName2 = workbook2.SheetNames[0];
			const sheet2 = workbook2.Sheets[sheetName2];
			const rows2 = xlsx.utils.sheet_to_json(sheet2, { defval: '', header: 1 });
			const data2 = {};

			rows2.forEach(function(row,idx,arr){
				// 결과를 저장할 배열과 변수
				// console.log(row)
				let content_no = 0;
				let title = '';
				if(idx < 1) {return;}
				content_no = row[1];
				title = row[2];
				data2[title] = content_no;
			})
			// console.log(data2);

			fs.unlinkSync(filePath2);

			// 파일이 제대로 다운로드 되어있는지 확인
			const expectedFileName = `북큐브 일별매출`;
			const matchedFile = fs.readdirSync(DOWNLOAD_DIR).find(name => name.startsWith(expectedFileName));
			if (!matchedFile) {
				console.log(`❌${expectedFileName}이 없습니다. 다운로드 실패로 간주합니다.`);
				resolve([]);
				return;
			}

			// 파일 이름을 platform_YYYY-MM-DD 꼴로 변경
			const filePath = renameDownloadedFile(matchedFile, Platform, yesterday);
			console.log(filePath)
			console.log(yesterday)

			const workbook = xlsx.readFile(filePath);
			const sheetName = workbook.SheetNames[0];
			const sheet = workbook.Sheets[sheetName];
			const rows = xlsx.utils.sheet_to_json(sheet, { defval: '', header: 1 });
			const data = [];

			rows.forEach(function(row,idx,arr){
				// 결과를 저장할 배열과 변수
				// console.log(row)
				let content_no = 0;
				let name = '';
				let totalSalesCount = 0;
				let totalRevenue = 0;
				if(idx < 2 || row[0] == '조회한 결과가 없습니다.' || row[0] != yesterday) {return;}
				// if(idx < 2) {return;}
				content_no = data2[row[1]];
				totalSalesCount = row[3];
				totalRevenue = row[4];
				data.push([ content_no, name, totalSalesCount, totalRevenue, totalRevenue*0.7 ])
			})
			console.log('파일 파싱 완료');

			// 중복되는 값들을 하나로 합치는 과정 추가
			const finalMap = new Map();

			data.forEach(row => {
				const [content_no, name, count, revenue, payout] = row;
				const key = `${content_no}::${name}`;

				if (!finalMap.has(key)) {
					finalMap.set(key, [content_no, name, 0, 0, 0]); // 초기값 설정
				}

				const entry = finalMap.get(key);
				entry[2] += Number(count);     // 총 판매수 합산
				entry[3] += Number(revenue);   // 총 매출 합산
				entry[4] += Number(payout);    // 총 정산금액 합산
			});

			const finaldata = Array.from(finalMap.values());
			// console.log(finaldata);

			fs.unlinkSync(filePath);
			resolve(finaldata);
		}else if(Platform == 'mrblue') {
			// 파일이 제대로 다운로드 되어있는지 확인
			const realday = getYesterday(2, 'file')
			const expectedFileName = `작품별정산_${realday}_${realday}`;
			const matchedFile = fs.readdirSync(DOWNLOAD_DIR).find(name => name.startsWith(expectedFileName));
			if (!matchedFile) {
				console.log(`❌${expectedFileName}이 없습니다. 다운로드 실패로 간주합니다.`);
				resolve([]);
				return;
			}

			// 파일 이름을 platform_YYYY-MM-DD 꼴로 변경
			const filePath = renameDownloadedFile(matchedFile, Platform, realday);
			console.log(filePath)

			const workbook = xlsx.readFile(filePath);
			const sheetName = workbook.SheetNames[0];
			const sheet = workbook.Sheets[sheetName];
			const rows = xlsx.utils.sheet_to_json(sheet, { defval: '', header: 1 });

			const data = [];
			rows.forEach(function(row,idx,arr){
				// console.log(row)
				if(idx == 5 ) {
					// 결과를 저장할 배열과 변수
					let content_no = 0;
					let name = '';
					let cancelcount = 0;
					let cancelrevenue = 0;
					let totalSalesCount = 0;
					let totalRevenue = 0;
					content_no = row[5];
					name = row[7]
					if (row[87] !== '미확정' && row[89] !== '미확정') {
						cancelcount = Number(row[87])
						cancelrevenue = Number(row[89])
					}
					totalSalesCount = Number(row[84]) - cancelcount
					totalRevenue = Number(row[86]) - cancelrevenue
					data.push([ content_no, name, totalSalesCount, totalRevenue, totalRevenue*0.63, realday ])
				}
			});
			console.log('파일 파싱 완료');
			fs.unlinkSync(filePath);
			resolve(data);
		}
	});
}

// 💾 DB 저장
async function saveToDB(Content_no, Name, Platform, Sales, Revenue, settlement, Date) {
	try{
		const connection = await mysql.createConnection(dbConfig);
		console.log(Content_no, Name, Platform, Sales, Revenue, settlement, Date)
		const sql = `INSERT INTO bis2203.매출 (작품코드, 작가명, 플랫폼명, 판매부수, 매출, 순매출, 날짜) VALUES (?, ?, ?, ?, ?, ?, ?)`;
		const [result] = await connection.execute(sql, [Content_no, Name, Platform, Sales, Revenue, settlement, Date]);
		console.log('✅ 저장 성공:');
		await connection.end(); // 연결 종료
	} catch (err) {
		console.error('❌ 저장 오류:', err.message);
		console.error('⚠️ 데이터:', [Content_no, Name, Platform, Sales, Revenue, settlement, Date]);
	}
}

async function downloadseries() {
	const driver = await new Builder()
		.forBrowser('chrome')
		.setChromeOptions(chromeOptions)
		.build();

	try {
		console.log("시리즈 목록 수집중...")

		// 로그인 시도
		await driver.manage().deleteAllCookies();
		await driver.get('https://friend.navercorp.com/login/loginForm.sec');
		await sleep(1000);

		// 로그인 폼 입력
		await driver.findElement(By.id('user_id')).sendKeys('bis2203')
		await sleep(300)
		await driver.findElement(By.id('user_pw')).sendKeys('apfhd@486')
		await sleep(300)
		await driver.findElement(By.id('btn-login')).click()
		await sleep(2000)

		// alert 처리
		await handleAlert(driver);

		await sleep(2000);
		const currentUrl = await driver.getCurrentUrl();
		console.log('📍 현재 URL:', currentUrl);

		// 매출 페이지로 이동
		await driver.get('https://friend.navercorp.com/main/welcome');
		const comicButton = await driver.wait(until.elementLocated(By.css('button.btn.btn-default.btn-lg')),5000);
		await comicButton.click();
		await sleep(1000);
		const link = await driver.wait(until.elementLocated(By.xpath("//a[contains(., '[CP용] 컨텐츠별 매출 통계')]")),5000);
		await link.click();
		await sleep(3000);

		// iframe으로 이동
		const iframe = await driver.findElement(By.css('iframe'));
		await driver.switchTo().frame(iframe);

		// 날짜 입력
		const date = getYesterday(1, 'date');
		console.log(date)
		const startDateInput = await driver.wait(until.elementLocated(By.id('startDate')),5000);
		await startDateInput.clear();
		await startDateInput.sendKeys(date);

		const endDateInput = await driver.wait(until.elementLocated(By.id('endDate')),5000);
		await endDateInput.clear();
		await endDateInput.sendKeys(date);
		console.log('✅ 날짜 입력 완료');

		// 조회 버튼 클릭
		const searchBtn = await driver.findElement(By.css('input[type="submit"][value="조회"]'));
		await searchBtn.click();
		console.log('🔍 조회 버튼 클릭');
		await sleep(2000);

		// 엑셀 다운로드 버튼 클릭
		const excelBtn = await driver.findElement(By.css('input[type="button"][value*="EXCEL"]'));
		await excelBtn.click();
		console.log('📥 엑셀 다운로드 클릭');
		await sleep(3000);

		// 다시 메인 프레임으로 나가야 함
		await driver.switchTo().defaultContent();
    } catch (e) {
        console.log(e);
	} finally {
        console.log('종료')
		await driver.quit();
	}
}

async function downloadkakao() {
	const driver = await new Builder()
		.forBrowser('chrome')
		.setChromeOptions(chromeOptions)
		.build();

	try {
		console.log("카카오 목록 수집중...")

		// 로그인 시도
		await driver.manage().deleteAllCookies();
		await driver.get('https://partner.kakaopage.com/auth/login');
		await sleep(1000);

		// 로그인 폼 입력
		await driver.findElement(By.css('input[name="id"]')).sendKeys('bis2203')
		await sleep(300)
		await driver.findElement(By.css('input[name="password"]')).sendKeys('apfhd@486')
		await sleep(300)
		await driver.findElement(By.css('button[type="submit"][data-testid="submit-button"]')).click();
		await sleep(2000)

		// alert로 전환
		// await handleAlert(driver);

		// 매출 페이지로 이동
		await driver.get('https://partner.kakaopage.com/statistics/seriesSales/daily');
		await sleep(2000)

		// 날짜 입력
		const date = getYesterday(1, 'file');
		const d = parseInt(date.split('-')[2], 10);
		const day = new Date(getYesterday(0, 'file')).getDate();
		const inputs = await driver.findElements(By.css('.react-datepicker__input-container input'));

		// 시작일 필드 클릭 → 달력 열기 달력에서 → 어제 날짜 클릭
		await inputs[0].click();
		await sleep(300); // 렌더링 대기
		if(day == 1) {
			const previousmonthBtn = await driver.findElement(By.css('button[aria-label^="Previous Month"]'));
			await previousmonthBtn.click();
			await sleep(1000);
		}
		const dateButton = await driver.findElement(By.xpath(`//div[contains(@class, 'react-datepicker__day') and not(contains(@class, 'outside-month')) and text()='${d}']`));
		await dateButton.click();
		await sleep(500);

		// 종료일도 동일하게 클릭
		await inputs[1].click();
		await sleep(300);
		if(day == 1) {
			const previousmonthBtn = await driver.findElement(By.css('button[aria-label^="Previous Month"]'));
			await previousmonthBtn.click();
			await sleep(1000);
		}
		const dateButton2 = await driver.findElement(By.xpath(`//div[contains(@class, 'react-datepicker__day') and not(contains(@class, 'outside-month')) and text()='${d}']`));
		await dateButton2.click();
		await sleep(500);

		console.log('✅ 날짜 입력 완료');
		await sleep(2000)

		// 조회 버튼 클릭<button class="css-1iiteto" type="submit" form="searchFormSeriesSales" data-id="search">조회</button>
		const searchBtn = await driver.wait(until.elementLocated(By.xpath("//button[text()='조회']")), 10000);
		await driver.wait(until.elementIsVisible(searchBtn), 5000);
		await driver.executeScript("arguments[0].click();", searchBtn);
		console.log('🔍 조회 버튼 클릭');
		await sleep(2000);

		// 엑셀 다운로드 버튼 클릭
		const excelBtn = await driver.findElement(By.xpath("//button[.//text()[contains(., '다운로드')]]"));
		await excelBtn.click();

		const download2010Btn = await driver.findElement(By.xpath("//button[@data-id='download' and @data-value='2010']"));
		await download2010Btn.click();
		console.log('📥 엑셀 다운로드 클릭');
		await sleep(2000);
    } catch (e) {
        console.log(e);
	} finally {
        console.log('종료')
		await driver.quit();
	}
}

async function downloadridi() {
	const driver = await new Builder()
		.forBrowser('chrome')
		.setChromeOptions(chromeOptions)
		.build();

	try {
		console.log("리디 목록 수집중...")

		// 로그인 시도
		await driver.manage().deleteAllCookies();
		await driver.get('https://cp.ridibooks.com/cp/login?return_uri=%2Fcp');
		await sleep(1000);

		// 로그인 폼 입력
		await driver.findElement(By.css('input[name="login_id"]')).sendKeys('773-020-02195')
		await sleep(300)
		await driver.findElement(By.css('input[name="password"]')).sendKeys('apfhd@486')
		await sleep(300)
		await driver.findElement(By.css('button.btn.btn-login.btn-double')).click();
		await sleep(2000)

		// 매출 페이지로 이동
		await driver.get('https://cp.ridibooks.com/calculate/by_date?main_reseller_id=0&view_type=m');
		await sleep(2000)
		// 날짜 입력
		const date = getYesterday(1, 'date');
		// JavaScript로 readonly 무시하고 값 설정
		await driver.executeScript(`document.getElementById('date_started').value = arguments[0];`, date);
		await sleep(300)
		await driver.executeScript(`document.getElementById('date_ended').value = arguments[0];`, date);
		await sleep(300)
		console.log('✅ 날짜 입력 완료');

		// 조회 버튼 클릭
		const searchBtn = await driver.wait(until.elementLocated(By.css('input[type="submit"][value="조회"]')), 10000);
		await driver.wait(until.elementIsVisible(searchBtn), 5000);
		await driver.executeScript("arguments[0].click();", searchBtn);
		console.log('🔍 조회 버튼 클릭');
		await sleep(2000);

		// 엑셀 다운로드 버튼 클릭
		const excelBtn = await driver.findElement(By.css('button.js_download_excel'));
		await excelBtn.click();
		console.log('📥 엑셀 다운로드 클릭');
		await sleep(3000);
    } catch (e) {
        console.log(e);
	} finally {
        console.log('종료')
		await driver.quit();
	}
}

async function downloadyes24() {
	const driver = await new Builder()
		.forBrowser('chrome')
		.setChromeOptions(chromeOptions)
		.build();

	try {
		console.log("예스24 목록 수집중...")

		// 로그인 시도
		await driver.manage().deleteAllCookies();
		await driver.get('https://cp.k-epub.com/main/Main.do');
		await sleep(1000);

		// 로그인 폼 입력
		await driver.findElement(By.css('input[name="userID"]')).sendKeys('bis2203')
		await sleep(300)
		await driver.findElement(By.css('input[name="pwd"]')).sendKeys('7732002195')
		await sleep(300)
		await driver.findElement(By.css('input[value="로그인"]')).click()
		await sleep(2000)

		// 매출 페이지로 이동
		await driver.get('https://cp.k-epub.com/calculate/sell/B2C.do');
		await sleep(300);
		
		// 날짜 입력
		const date = getYesterday(1, 'file');
		await driver.executeScript(`
			const input = document.getElementById('date1');
			input.value = arguments[0];
			input.dispatchEvent(new Event('input', { bubbles: true }));
			input.dispatchEvent(new Event('change', { bubbles: true }));
		`, date);
		await sleep(300)
		await driver.executeScript(`
			const input = document.getElementById('date2');
			input.value = arguments[0];
			input.dispatchEvent(new Event('input', { bubbles: true }));
			input.dispatchEvent(new Event('change', { bubbles: true }));
		`, date);
		await sleep(300)
		console.log('✅ 날짜 입력 완료');

		// 조회 버튼 클릭
		await driver.executeScript('funSearch();');
		console.log('🔍 조회 버튼 클릭');
		await sleep(2000);

		// 엑셀 다운로드 버튼 클릭
		await driver.executeScript('excelExport();');
		console.log('📥 엑셀 다운로드 클릭');
		await sleep(3000);

		// 대화상자 대기 후 '확인' 누르기
		try {
			const alert = await driver.wait(until.alertIsPresent(), 5000); // 최대 5초 대기
			await alert.accept(); // 확인 클릭
			console.log('✅ 확인 버튼 클릭 완료');
		} catch (err) {
			console.error('❌ alert 확인 실패:', err.message);
		}
		await sleep(3000)
	} catch (e) {
        console.log(e);
	} finally {
        console.log('종료')
		await driver.quit();
	}
}

async function downloadkyobo() {
	const driver = await new Builder()
		.forBrowser('chrome')
		.setChromeOptions(chromeOptions)
		.build();

	try {
		console.log("교보문고 목록 수집중...")

		// 로그인 시도
		await driver.manage().deleteAllCookies();
		await driver.get('https://partner.kyobobook.co.kr/login');
		await sleep(1000);

		// 로그인 폼 입력
		await driver.findElement(By.id('id')).sendKeys('bis2203')
		await sleep(300)
		await driver.findElement(By.id('pwd')).sendKeys('apfhd@486')
		await sleep(300)
		await driver.findElement(By.id('loginBtn')).click()
		await sleep(2000)

		// 매출 페이지로 이동
		const target = await driver.findElement(By.xpath("//a[contains(text(), '판매내역조회')]"));
		await driver.executeScript("arguments[0].click();", target);
		await sleep(300);
		const label = await driver.findElement(By.css('label[for="day"]'));
		await label.click();
		await sleep(300);
		
		// 날짜 입력
		const date = getYesterday(1, 'date');
		await driver.executeScript(`document.querySelector('input[name="strtDttm"]').value = arguments[0];`, date);
		await sleep(300)
		await driver.executeScript(`document.querySelector('input[name="endDttm"]').value = arguments[0];`, date);
		await sleep(300)
		console.log('✅ 날짜 입력 완료');

		// 조회 버튼 클릭
		const searchBtn = await driver.wait(until.elementLocated(By.css('button[id="searchBtn"]')), 10000);
		await driver.wait(until.elementIsVisible(searchBtn), 5000);
		await driver.executeScript("arguments[0].click();", searchBtn);
		console.log('🔍 조회 버튼 클릭');
		await sleep(2000);

		// 엑셀 다운로드 버튼 클릭
		const excelBtn = await driver.findElement(By.css('button#excelDownBtn1'));
		await excelBtn.click();
		console.log('📥 엑셀 다운로드 클릭');
		await sleep(3000);
	} catch (e) {
        console.log(e);
	} finally {
        console.log('종료')
		await driver.quit();
	}
}

async function downloadjoara() {
	const driver = await new Builder()
		.forBrowser('chrome')
		.setChromeOptions(chromeOptions)
		.build();

	try {
		console.log("조아라 목록 수집중...")

		// 로그인 시도
		await driver.manage().deleteAllCookies();
		await driver.get('https://cp.joara.com/');
		await sleep(1000);

		// 로그인 폼 입력 https://cp.joara.com/literature/account/account_list.html
		await driver.findElement(By.css('input[name="member_id"]')).sendKeys('bis2203')
		await sleep(300)
		await driver.findElement(By.css('input[name="passwd"]')).sendKeys('#bis2203')
		await sleep(300)
		await driver.findElement(By.css('input[src="images/btn_login.gif"]')).click();
		await sleep(2000)

		// 매출 페이지로 이동
		await driver.get('https://cp.joara.com/literature/account/account_list.html');
		await sleep(2000)

		const day = new Date(getYesterday(0, 'file')).getDate();
		const month = new Date(getYesterday(1, 'file')).getMonth();
		if(day == 1) {
			const selectElement = await driver.findElement(By.id('s_month'));
			const optionToSelect = await selectElement.findElement(By.css(`option[value="${month+1}"]`));
			await optionToSelect.click();
			await sleep(2000);
		}

		const rows = await driver.findElements(By.css('div.table_wrap tr'));
		const results = [];

		for (const row of rows) {
			const tds = await row.findElements(By.css('td'));
			if (tds.length === 0) continue; // 헤더 또는 빈 tr 무시
			const isnothing = await tds[0].getText();
			if(isnothing == '* 정산 내역이 없습니다.') break;

			const span = await tds[0].findElement(By.css('span.list1'));
			const contentNo = await span.getAttribute('name');
			const title = await span.getText();

			const values = [contentNo, title];
			for (let i = 1; i < 3; i++) {
				values.push(await tds[i].getText());
			}

			// ✅ 팝업 열기 (클릭)
			await driver.executeScript("arguments[0].scrollIntoView(true);", span);
			await span.click();
			await driver.sleep(500); // 팝업 로딩 대기

			// ✅ 팝업 내 행 수집
			const popupRows = await driver.findElements(By.css('.pop tbody#work_list tr'));
			for (const popupRow of popupRows) {
				const popupTds = await popupRow.findElements(By.css('td'));
				const date = await popupTds[0].getText();
				if( date != getYesterday(1, 'file')) {
					continue;
				}
				const sales = await popupTds[1].getText();
				const cancels = await popupTds[2].getText();

				results.push([values[0], values[2], Number(sales)-Number(cancels), (Number(sales)-Number(cancels))*Number(values[3]), (Number(sales)-Number(cancels))*Number(values[3])*0.6])
			}
			
			// ✅ 팝업 닫기 (버튼 클릭)
			const closeBtn = await driver.findElement(By.css('.pop a.btn_style'));
			await closeBtn.click();
			await driver.sleep(300); // 팝업 닫힘 대기
		}
		// console.log(results)
		await sleep(2000);

		return results
    } catch (e) {
        console.log(e);
	} finally {
        console.log('종료')
		await driver.quit();
	}
}

async function downloadaladin() {
	const driver = await new Builder()
		.forBrowser('chrome')
		.setChromeOptions(chromeOptions)
		.build();

	try {
		console.log("알라딘 목록 수집중...")

		// 로그인 시도
		await driver.manage().deleteAllCookies();
		await driver.get('https://ebookcms.aladin.co.kr/Account/Login');
		await sleep(1000);

		// 팝업창 닫기
		const handles = await driver.getAllWindowHandles();

		if (handles.length > 1) {
			const mainHandle = handles[0];
			const popupHandle = handles[1];

			// 팝업으로 전환
			await driver.switchTo().window(popupHandle);
			await driver.close(); // 팝업 닫기

			// 다시 원래 창으로 복귀
			await driver.switchTo().window(mainHandle);
		}

		// 로그인 폼 입력
		await driver.findElement(By.id('UserId')).sendKeys('bis2203')
		await sleep(300)
		await driver.findElement(By.id('Password')).sendKeys('apfhd486')
		await sleep(300)
		await driver.findElement(By.css('.btn_login')).click()
		await sleep(2000)

		// 매출 페이지로 이동
		await driver.get('https://ebookcms.aladin.co.kr/Stats/Caculate');
		const label = await driver.wait(until.elementLocated(By.css('input[value="DAILY"]')),5000);
		await label.click();
		await sleep(300);
		
		// 날짜 입력
		const date = getYesterday(1, 'file');
		await driver.executeScript(`document.querySelector('input[id="startDay"]').value = arguments[0];`, date);
		await sleep(300)
		await driver.executeScript(`document.querySelector('input[id="endDay"]').value = arguments[0];`, date);
		await sleep(300)
		console.log('✅ 날짜 입력 완료');

		// 조회 버튼 클릭
		await driver.executeScript('searchDaily();');
		console.log('🔍 조회 버튼 클릭');
		await sleep(2000);

		// 엑셀 다운로드 버튼 클릭
		await driver.executeScript('DailyExcelDownload();');
		console.log('📥 엑셀 다운로드 클릭');
		await sleep(3000);
	} catch (e) {
        console.log(e);
	} finally {
        console.log('종료')
		await driver.quit();
	}
}

async function downloadblice() {
	const driver = await new Builder()
		.forBrowser('chrome')
		.setChromeOptions(chromeOptions)
		.build();

	try {
		console.log("블라이스 목록 수집중...")

		// 로그인 시도
		await driver.manage().deleteAllCookies();
		await driver.get('https://www.blice.co.kr/web/homescreen/main.kt?service=WEBNOVEL&genre=romance');
		await sleep(1000);

		// 팝업창 닫기
		const handles = await driver.getAllWindowHandles();

		if (handles.length > 1) {
			const mainHandle = handles[0];
			const popupHandle = handles[1];

			// 팝업으로 전환
			await driver.switchTo().window(popupHandle);
			await driver.close(); // 팝업 닫기

			// 다시 원래 창으로 복귀
			await driver.switchTo().window(mainHandle);
		}

		// 로그인 폼 입력
		await driver.findElement(By.css('.btn-login')).click()
		await sleep(2000)
		await driver.findElement(By.id('userid')).sendKeys('dmlaldjqtek9@naver.com')
		await sleep(300)
		await driver.findElement(By.id('passwd')).sendKeys('apfhd@4862')
		await sleep(300)
		await driver.findElement(By.id('ktnovelLogin')).click()
		await sleep(5000)

		// 매출 페이지로 이동
		await driver.get('https://www.blice.co.kr/web/my/sales_info.kt');
		await sleep(300)
		const label = await driver.wait(until.elementLocated(By.css('label[for="rdoDate2"]')),5000);
		await label.click();
		await sleep(300);
		
		// 날짜 입력
		const date = getYesterday(1, 'file');
		await driver.executeScript(`document.getElementById('calculateFirstDate').value = arguments[0];`, date);
		await sleep(300)
		await driver.executeScript(`document.querySelector('input[name="end_dt"]').value = arguments[0];`, date);
		await sleep(300)
		console.log('✅ 날짜 입력 완료');

		// 조회 버튼 클릭
		const searchBtn = await driver.wait(until.elementLocated(By.css('.searchBtn')), 10000);
		await driver.executeScript("arguments[0].click();", searchBtn);
		console.log('🔍 조회 버튼 클릭');
		await sleep(2000);

		// 엑셀 다운로드 버튼 클릭
		const excelBtn = await driver.findElement(By.css('button#excelDownBtn'));
		await excelBtn.click();
		console.log('📥 엑셀 다운로드 클릭');
		await sleep(3000);
	} catch (e) {
        console.log(e);
	} finally {
        console.log('종료')
		await driver.quit();
	}
}

async function downloadbomtoon() {
	const driver = await new Builder()
		.forBrowser('chrome')
		.setChromeOptions(chromeOptions)
		.build();

	try {
		console.log("봄툰 목록 수집중...")

		// 로그인 시도
		await driver.manage().deleteAllCookies();
		await driver.get('https://partner.balcony.studio/login');
		await sleep(1000);

		// 팝업창 닫기
		const handles = await driver.getAllWindowHandles();

		if (handles.length > 1) {
			const mainHandle = handles[0];
			const popupHandle = handles[1];

			// 팝업으로 전환
			await driver.switchTo().window(popupHandle);
			await driver.close(); // 팝업 닫기

			// 다시 원래 창으로 복귀
			await driver.switchTo().window(mainHandle);
		}

		// 로그인 폼 입력
		await driver.findElement(By.id('email')).sendKeys('edit@biscuitsmedia.com')
		await sleep(300)
		await driver.findElement(By.id('password')).sendKeys('apfhd@486')
		await sleep(300)
		await driver.findElement(By.css('button[type="submit"]')).click()
		await sleep(5000)

		// 매출 페이지로 이동
		await driver.get('https://partner.balcony.studio/contents/statisticsByDatePeriod');
		await sleep(300)
		const selectBox = await driver.findElement(By.css('.MuiSelect-select'));
		await selectBox.click();
		await sleep(300)
		const li = await driver.wait(until.elementLocated(By.css("li[data-value='BOMTOON_COM']")),5000);
		await li.click();
		await sleep(300);
		
		// 날짜 입력
		const date = getYesterday(1, 'file');
		const targetDate = new Date(date);
		const timestamp = targetDate.getTime() - (9 * 60 * 60 * 1000);
		
		const calendarBtn = await driver.findElements(By.css('button[aria-label^="Choose date"]'));
		await calendarBtn[0].click();
		await driver.sleep(1000); // 달력 렌더링 대기
		const nextmonthBtn = await driver.findElement(By.css('button[aria-label^="Next month"]'));
		const day = new Date(getYesterday(0, 'file')).getDate();
		if(day != 1) {
			await nextmonthBtn.click();
			await sleep(1000);
		}
		const dayBtn = await driver.findElement(By.css(`button[data-timestamp="${timestamp}"]`));
		await driver.sleep(300);
		await dayBtn.click();
		await sleep(1000)

		await calendarBtn[1].click();
		await driver.sleep(1000); // 달력 렌더링 대기
		if(day == 1) {
			const previousmonthBtn = await driver.findElement(By.css('button[aria-label^="Previous month"]'));
			await previousmonthBtn.click();
			await sleep(1000);
		}
		const dayBtn2 = await driver.findElement(By.css(`button[data-timestamp="${timestamp}"]`));
		await driver.sleep(300);
		await dayBtn2.click();
		await sleep(1000)
		console.log('✅ 날짜 입력 완료');

		// 조회 버튼 클릭
		const searchBtn = await driver.wait(until.elementLocated(By.xpath("//button[text()='검색']")), 10000);
		await driver.executeScript("arguments[0].click();", searchBtn);
		console.log('🔍 조회 버튼 클릭');
		await sleep(2000);

		// 엑셀 다운로드 버튼 클릭
		const excelBtn = await driver.wait(until.elementLocated(By.xpath("//button[text()='엑셀 다운로드']")), 10000);
		await driver.executeScript("arguments[0].click();", excelBtn);
		console.log('📥 엑셀 다운로드 클릭');
		await sleep(3000);

		// 작품관리 페이지로 이동
		await driver.get('https://partner.balcony.studio/store/contents');
		await sleep(3000);
		const trs = await driver.findElements(By.css('.MuiTableRow-root'));

		for (const tr of trs) {
			try {
				const tds = await tr.findElements(By.css('td'));

				if (tds.length >= 2) {
					const title = await tds[0].getText(); // 첫 번째 td: 제목
					const codeLink = await tds[1].findElement(By.css('a'));
					const code = await codeLink.getText(); // 두 번째 td의 <a> 텍스트: 코드

					bomtoon_codes[title] = code
				}
			} catch (err) {
				console.error('❌ 오류 발생:', err.message);
			}
		}
	} catch (e) {
        console.log(e);
	} finally {
        console.log('종료')
		await driver.quit();
	}
}

async function downloadbookcube() {
	const driver = await new Builder()
		.forBrowser('chrome')
		.setChromeOptions(chromeOptions)
		.build();

	try {
		console.log("북큐브 목록 수집중...")

		// 로그인 시도
		await driver.manage().deleteAllCookies();
		await driver.get('https://scm.bookcube.com/');
		await sleep(1000);

		// 로그인 폼 입력
		await driver.findElement(By.id('userid')).sendKeys('비스킷미디어')
		await sleep(300)
		await driver.findElement(By.css('input[name="password"]')).sendKeys('20240901!q')
		await sleep(300)
		await driver.findElement(By.css('button[type="submit"]')).click()
		await sleep(5000)
		
		const closeButtons = await driver.findElements(By.xpath("//button[.//span[normalize-space(text())='닫기']]"));
		for (const button of closeButtons) {
			try {
				await button.click();
				await sleep(200); // 클릭 간 딜레이 (필요시)
			} catch (e) {
				console.error('❌ 닫기 버튼 클릭 실패:', e.message);
			}
		}

		// 등록현황 페이지로 이동
		await driver.get('https://scm.bookcube.com/book');
		await sleep(2000)

		// 엑셀 다운로드 버튼 클릭
		const excelBtn2 = await driver.wait(until.elementLocated(By.xpath("//button[.//span[normalize-space(text())='엑셀다운']]")), 10000);
		await driver.executeScript("arguments[0].click();", excelBtn2);
		console.log('📥 작품정보 다운로드');
		await sleep(3000);

		// 매출 페이지로 이동
		await driver.get('https://scm.bookcube.com/sales/days');
		await sleep(2000)

		// 조회 버튼 클릭
		const searchBtn = await driver.wait(until.elementLocated(By.xpath("//button[.//span[normalize-space(text())='검색']]")), 10000);
		await driver.executeScript("arguments[0].click();", searchBtn);
		console.log('🔍 조회 버튼 클릭');
		await sleep(2000);

		// 엑셀 다운로드 버튼 클릭
		const excelBtn = await driver.wait(until.elementLocated(By.xpath("//button[.//span[normalize-space(text())='엑셀다운']]")), 10000);
		await driver.executeScript("arguments[0].click();", excelBtn);
		console.log('📥 엑셀 다운로드 클릭');
		await sleep(3000);
	} catch (e) {
        console.log(e);
	} finally {
        console.log('종료')
		await driver.quit();
	}
}

async function downloadmrblue() {
	const driver = await new Builder()
		.forBrowser('chrome')
		.setChromeOptions(chromeOptions)
		.build();

	try {
		console.log("미스터블루 목록 수집중...")

		// 로그인 시도
		await driver.manage().deleteAllCookies();
		await driver.get('https://cp-manage.mrblue.com/');
		await sleep(1000);

		// 로그인 폼 입력
		await driver.findElement(By.css('input[name="id"]')).sendKeys('biscuits')
		await sleep(300)
		await driver.findElement(By.css('input[name="password"]')).sendKeys('biscuits3612@!')
		await sleep(300)
		await driver.findElement(By.css('span.MuiButton-label')).click();
		await sleep(2000)

		// 매출 페이지로 이동
		await driver.get('https://cp-manage.mrblue.com/calculate');
		await sleep(2000)
		const tabSpan = await driver.wait(until.elementLocated(	By.xpath(`//li[@slot='tab']//span[normalize-space()='작품별 정산']`)),10000);

		// 클릭 가능해질 때까지 대기 후 클릭
		await driver.wait(until.elementIsVisible(tabSpan), 10000);
		await driver.wait(until.elementIsEnabled(tabSpan), 10000);
		await tabSpan.click();
		console.log('✅ 탭 이동 완료');

		// 조회 버튼 클릭
		const searchBtn = await driver.wait(until.elementLocated(By.xpath("//button[.//text()[normalize-space()='조회']]")), 10000);
		await driver.wait(until.elementIsVisible(searchBtn), 5000);
		await driver.executeScript("arguments[0].click();", searchBtn);
		console.log('🔍 조회 버튼 클릭');
		await sleep(2000);

		// 엑셀 다운로드 버튼 클릭
		const excelBtn = await driver.findElement(By.xpath("//button[contains(normalize-space(),'엑셀로 저장')]"));
		await excelBtn.click();
		console.log('📥 엑셀 다운로드 클릭');
		await sleep(3000);
    } catch (e) {
        console.log(e);
	} finally {
        console.log('종료')
		await driver.quit();
	}
}

async function crawling(platform) {
	const salesDate = getYesterday(1, 'file');
	let data = [];
	if(platform=="series") {await downloadseries();}
	else if(platform=="kakao") {await downloadkakao();}
	else if(platform=="ridi") {await downloadridi();}
	else if(platform=="kyobo") {await downloadkyobo();}
	else if(platform=="aladin") {await downloadaladin();}
	else if(platform=="joara") {data = await downloadjoara();}
	else if(platform=="blice") {await downloadblice();}
	// else if(platform=="piuri") {await downloadpiuri();};
	else if(platform=="yes24") {await downloadyes24();}
	else if(platform=="bomtoon") {await downloadbomtoon();}
	else if(platform=="bookcube") {await downloadbookcube();}
	else if(platform=="mrblue") {await downloadmrblue();}

	await sleep(1000);
	if (platform !== "joara") {
		// ▶ 파싱
		data = await parseExcel(platform, salesDate);
	}

	console.log(data)

	if (platform == "mrblue") {
		for(row of data) {
			await saveToDB(row[0], row[1], platform, row[2], row[3], row[4], row[5]);
		}
	}else{
		for(row of data) {
			await saveToDB(row[0], row[1], platform, row[2], row[3], row[4], salesDate);
		}
	}
}

// const run = async () => {
// 	const platforms = ['series', 'kakao', 'ridi', 'kyobo', 'aladin'];
// 	for (const platform of platforms) {
// 		await crawling(platform);
// 	}
// 	console.log('✅ 모든 플랫폼 크롤링 및 저장 완료!');
//   	process.exit(0);  // 👈 Node.js 프로세스 종료
// }

const run = async () => {
	await crawling("series");
	await crawling("kakao");
	await crawling("ridi");
	await crawling("kyobo");
	await crawling("aladin");
	await crawling("joara");
	await crawling("blice");
	await crawling("yes24");
	await crawling("bomtoon");
	await crawling("bookcube");
	await crawling("mrblue")
	console.log('✅ 모든 플랫폼 크롤링 및 저장 완료!');
  	process.exit(0);  // 👈 Node.js 프로세스 종료
}


run();

// function generateDateList(startStr, endStr) {
// 	const start = new Date(startStr);
// 	const end = new Date(endStr);
// 	const result = [];

// 	while (start <= end) {
// 		result.push(new Date(start)); // 복사본 저장
// 		start.setDate(start.getDate() + 1);
// 	}
// 	return result;
// }

// const runs = async (startDate, endDate) => {
// 	const dates = generateDateList(startDate, endDate);
// 	for (const date of dates) {
// 		TODAY = date; // ⬅ 전역 변수 TODAY 업데이트
// 		await run();
// 	}
// 	console.log('✅ 모든 날짜 크롤링 완료!');
// 	process.exit(0);
// };

// runs('2024-03-02', '2024-05-02')
