
const chrome = require('selenium-webdriver/chrome');
const xlsx = require('xlsx');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const csv = require('csv-parser');
const iconv = require('iconv-lite');

// ✅ 설정값들
const DOWNLOAD_DIR = path.resolve(__dirname, 'downloads');

// 연결 정보 설정
const dbConfig = {
	host: 'biscuitsmedia.cafe24app.com',
	user: 'bis2203',
	password: 'apfhd@4862',
	database: 'bis2203'
};

// 📅 어제 날짜 구하기
function getYesterday(format = 'file') {
	const d = new Date();
	console.log(d)
	d.setDate(d.getDate() - 1); // ← 어제 날짜
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	const dd = String(d.getDate()).padStart(2, '0');
	return format === 'file' ? `${yyyy}-${mm}-${dd}` : `${yyyy}${mm}${dd}`;
}

function getToday(format = 'file') {
	const d = new Date();
	console.log(d)
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	const dd = String(d.getDate()).padStart(2, '0');
	return format === 'file' ? `${yyyy}-${mm}-${dd}` : `${yyyy}${mm}${dd}`;
}

function renameDownloadedFile(beforeName, platform) {
	const oldPath = path.join(DOWNLOAD_DIR, beforeName);
	const ext = path.extname(beforeName);
	const newFileName = `${platform}${ext}`;
	const newPath = path.join(DOWNLOAD_DIR, newFileName);
	
	// 파일 이름 변경
	fs.renameSync(oldPath, newPath);

	return newPath;
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

function parseExcel(Platform) {
	return new Promise(async(resolve, reject) => {
		if(Platform == 'series') {
			// 파일이 제대로 다운로드 되어있는지 확인
			const expectedFileName = `contentsSelling_`;
			console.log(expectedFileName)
			const matchedFile = fs.readdirSync(DOWNLOAD_DIR).find(name => name.startsWith(expectedFileName));
			if (!matchedFile) {
				console.log(`❌${expectedFileName}이 없습니다. 다운로드 실패로 간주합니다.`);
				resolve([]);
			}

			// 파일 이름을 platform_YYYY-MM-DD 꼴로 변경
			const filePath = renameDownloadedFile(matchedFile, Platform);
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
				date = row[0];
				content_no = row[2];
				if(content_no == '' ) {return;}
				name = row[5];
				totalSalesCount = row[30] + row[36] + row[42] + row[48] + row[54] + row[60] + row[66];
				totalRevenue = row[row.length-1]
				// console.log(row)
				data.push([ content_no, name, totalSalesCount, totalRevenue, totalRevenue*0.7, date ])
			});
			console.log('파일 파싱 완료');
			fs.unlinkSync(filePath);
			resolve(data);

		}else if(Platform == 'kakao') {
			// 파일이 제대로 다운로드 되어있는지 확인
			const expectedFileName = `시리즈일매출통계`;
			const matchedFile = fs.readdirSync(DOWNLOAD_DIR).find(name => name.startsWith(expectedFileName));
			if (!matchedFile) {
				console.log(`❌${expectedFileName}이 없습니다. 다운로드 실패로 간주합니다.`);
				resolve([]);
			}

			// 파일 이름을 platform_YYYY-MM-DD 꼴로 변경
			const filePath = renameDownloadedFile(matchedFile, Platform);
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
				let date = new Date();

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
					`, [content_no, date, date]);

					if (rows2.length > 0) charge = rows2[0].수수료;
				} catch (err) {
					console.error('❌ 수수료 조회 실패:', err.message);
				}

				const settlement = totalRevenue * (100 - charge) / 100;
				data.push([content_no, name, totalSalesCount, totalRevenue, settlement, date]);
			}

			await db.end();
			fs.unlinkSync(filePath);
			console.log('파일 파싱 완료');
			resolve(data);
		}else if(Platform == 'ridi') {
			// 파일이 제대로 다운로드 되어있는지 확인
			const expectedFileName = `calculate_date_`;
			const matchedFile = fs.readdirSync(DOWNLOAD_DIR).find(name => name.startsWith(expectedFileName));
			if (!matchedFile) {
				console.log(`❌${expectedFileName}이 없습니다. 다운로드 실패로 간주합니다.`);
				resolve([]);
			}

			const filePath = unzipAndRename(DOWNLOAD_DIR, `${expectedFileName}20250201_20250531.zip`, `${Platform}.csv`);

			

			// 파일 이름을 platform_YYYY-MM-DD 꼴로 변경
			// console.log(filePath)
			let content_no = 0;
			let name = '';
			let totalSalesCount = 0;
			let totalRevenue = 0;
			const data = [];
			const stream = fs.createReadStream(filePath)
			
			stream.on('error', (err) => {
				console.error(err.message);
			});
			
			stream
			.pipe(csv())
			.on('data', (row) => {
				// 수식 컬럼만 출력
				content_no = row['도서 ID'] || 0;
				date = row['기준일'] || '';
				const cell = row['저자'] || '';
				name = cell.match(/T\("(.*)"\)/)[1];
				totalSalesCount = row['판매권'] || 0;
				totalRevenue = row['판매액'] || 0;
				totalSettlement = row['정산액'] || 0;
				data.push([Number(content_no), name, Number(totalSalesCount), Number(totalRevenue), Number(totalSettlement), date]);
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
			}

			// 파일 이름을 platform_YYYY-MM-DD 꼴로 변경
			const filePath = renameDownloadedFile(matchedFile, Platform);
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
				date = row[0];
				name = row[6];
				totalSalesCount = row[10];
				totalRevenue = row[11]
				data.push([ content_no, name, totalSalesCount, totalRevenue, totalRevenue*0.7, date ])
			})
			console.log('파일 파싱 완료');
			fs.unlinkSync(filePath);
			resolve(data);
		}else if(Platform == 'aladin') {
			// 파일이 제대로 다운로드 되어있는지 확인
			const expectedFileName = `sales_`;
			const matchedFile = fs.readdirSync(DOWNLOAD_DIR).find(name => name.startsWith(expectedFileName));
			if (!matchedFile) {
				console.log(`❌${expectedFileName}이 없습니다. 다운로드 실패로 간주합니다.`);
				resolve([]);
			}

			// 파일 이름을 platform_YYYY-MM-DD 꼴로 변경
			const filePath = renameDownloadedFile(matchedFile, Platform);
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
				console.log(row)
				let content_no = 0;
				let date = new Date();
				console.log(date)
				let name = '';
				let totalSalesCount = 0;
				let totalRevenue = 0;
				if(idx == 0 ) {return;}
				content_no = row[1];
				name = row[8];
				totalRevenue = row[5]
				data.push([ content_no, name, totalSalesCount, totalRevenue, totalRevenue*0.7, date ])
			})

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


async function crawling(platform) {
	const salesDate = getYesterday('file');

	await sleep(1000);
	// ▶ 파싱
	const data = await parseExcel(platform, salesDate);

	console.log(data)

	for(row of data) {
		await saveToDB(row[0], row[1], platform, row[2], row[3], row[4], row[5]);
	}
}

const run = async () => {
	// await crawling("series");
	// await crawling("kakao");
	// await crawling("ridi");
	// await crawling("kyobo");
	// await crawling("aladin");
	// await crawling("yes24");
	// await crawling("joara");
	console.log('✅ 모든 플랫폼 크롤링 및 저장 완료!');
  	process.exit(0);  // 👈 Node.js 프로세스 종료
}


run();
