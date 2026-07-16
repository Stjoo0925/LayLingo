# LayLingo

PDF 화면의 텍스트를 클릭해 한국어로 번역하고, 번역문 서식을 실시간으로 조정하는 편집기 MVP입니다.

## 실행

```powershell
npm install
npm run dev
```

브라우저에서 `http://localhost:5173`을 엽니다. API 키가 없으면 데모 모드로 실행되어 전체 편집 흐름을 시험할 수 있습니다.

실제 OpenAI 번역을 사용하려면 같은 PowerShell 세션에서 환경 변수를 지정한 뒤 실행합니다.

```powershell
$env:OPENAI_API_KEY="발급받은 API 키"
$env:OPENAI_MODEL="gpt-5"
npm run dev
```

API 키는 프론트엔드 코드나 `.env` 커밋에 포함하지 마세요.

## 현재 지원

- 텍스트형 PDF 업로드와 페이지 렌더링
- PDF 텍스트 영역 클릭 번역
- 번역문 직접 수정
- 폰트, 크기, 색상, 굵기, 정렬 편집
- 페이지 이동과 확대·축소
- API 키 미설정 시 데모 번역

스캔 PDF OCR과 편집 결과 PDF 내보내기는 후속 범위입니다. 상세 범위와 기술 설계는 [MVP 기획서](docs/MVP_PLAN.md)를 참고하세요.

## 검증

```powershell
npm test
npm run build
```
