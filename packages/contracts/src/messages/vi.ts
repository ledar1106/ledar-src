/**
 * Tiếng Việt — viết cho người CHỊU TRÁCH NHIỆM về database mà không xây nó.
 *
 * Không phải bản dịch từng chữ của `en.ts`. Bản tiếng Anh nói với một người
 * đọc tiếng Anh; bản này nói với người mà cổng VS-7 vừa đo được là **không đọc
 * nổi bản kia** — và đó là lý do file này tồn tại, không phải sự tiện lợi.
 *
 * ## Ba quyết định về từ, ghi lại để lần sau không phải đoán
 *
 * ① Giữ nguyên `index`, `foreign key`, `constraint` là **ràng buộc**.
 *    "Chỉ mục" đúng từ điển và sai thực địa: người quản lý sản phẩm Việt Nam
 *    nghe "index" hàng ngày và chưa bao giờ nghe "chỉ mục". Dịch nó ra là bắt
 *    người đọc học một từ mới để hiểu một thứ họ đã biết tên.
 *
 * ② KHÔNG dùng "lỗi" cho phát hiện Tầng B. Bản tiếng Anh cẩn thận nói
 *    *"patterns worth asking about — not problems"*, và luật F.12 cấm từ chỉ
 *    khuyết tật ở mức tin cậy đó. "Lỗi" trong tiếng Việt nặng hơn "pattern"
 *    rất nhiều, nên nó phá đúng cái hàng rào ấy. Dùng "chỗ đáng hỏi lại".
 *
 * ③ Xưng "tôi", gọi người đọc là "bạn". Bản tiếng Anh dùng ngôi thứ nhất và
 *    đó là một lựa chọn thiết kế: công cụ chịu trách nhiệm về câu nó nói.
 *    "Hệ thống đã kiểm tra…" là giọng của một bản báo cáo không ai ký tên.
 *
 * ## Số đếm
 *
 * Tiếng Việt không biến đổi danh từ theo số, nên `plural()` gần như không
 * xuất hiện ở đây — trong khi `en.ts` cần nó ở mười ba chỗ. Đây đúng là lý do
 * catalogue là HÀM chứ không phải chuỗi mẫu: `"{n} tables"` ép mọi ngôn ngữ đi
 * qua ngữ pháp tiếng Anh.
 */

// Type-only. This file must not import anything from i18n.ts at
// runtime: i18n.ts imports THIS file, and a value-level cycle would
// make which half initialises first depend on who imported what.
import type { Catalog } from '../i18n.js';

const s = (p: Record<string, string | number>, key: string): string =>
  String(p[key] ?? '');

export const VI: Catalog = {
  // ---- tiêu đề ----
  'head.looked-at': () => 'TÔI NHÌN ĐƯỢC NHỮNG GÌ',
  'head.database-confirms': () => 'NHỮNG GÌ CHÍNH DATABASE XÁC NHẬN',
  'head.patterns': () => 'NHỮNG CHỖ ĐÁNG HỎI LẠI',
  'head.verdict': () => 'BÁO CÁO NÀY CHỨNG MINH ĐƯỢC GÌ, VÀ KHÔNG CHỨNG MINH ĐƯỢC GÌ',

  // ---- giọng của bộ quét ----
  'scan.connected-as': (p) =>
    `kết nối bằng tài khoản ${s(p, 'user')}, quyền chỉ-đọc ${s(p, 'enforcement')}`,
  'scan.read-only-enforced': () => 'do chính database bắt buộc',
  'scan.read-only-not-enforced': () => 'KHÔNG được bắt buộc',

  'scan.every-table-empty': () => 'MỌI BẢNG Ở ĐÂY ĐỀU RỖNG.',
  'scan.every-table-empty.body': () =>
    'Không có câu nào bên dưới nói về dữ liệu của bạn, vì không có dữ liệu ' +
    'nào cả. Tôi chỉ xem được phần cấu trúc. Một kết quả sạch trên một ' +
    'database rỗng nghĩa là chưa có gì được xem — không phải là mọi thứ đều ổn.',
  'scan.tables-empty-line': (p) =>
    `${s(p, 'empty')} trong ${s(p, 'total')} bảng không có dòng nào — các ` +
    `luật đọc dữ liệu không nói được gì về những bảng đó`,
  'scan.tables-empty-line.share': (p) =>
    `${s(p, 'empty')} trong ${s(p, 'total')} bảng (${s(p, 'share')} số bảng ` +
    `ở đây) không có dòng nào — các luật đọc dữ liệu không nói được gì về ` +
    `những bảng đó`,

  'scan.facts-are-facts': () =>
    'Các con số ở đây là sự thật — chạy lại một câu truy vấn là ra đúng từng ' +
    'con số. Còn một sự thật có phải là vấn đề hay không lại là câu hỏi khác, ' +
    'và tôi không trả lời thay bạn được.',
  'scan.patterns-preamble': () =>
    'Đây không phải là lỗi. Đây là những chỗ trông như đang theo một quy tắc ' +
    'mà không ai viết ra. Tôi không phân biệt được đâu là thứ bỏ sót và đâu ' +
    'là chủ ý — chỉ bạn mới biết.',
  'scan.nothing-stood-out': () => 'Không có chỗ nào nổi lên.',

  'scan.where': (p) => `ở đâu: ${s(p, 'target')}`,
  'scan.where-with-severity': (p) =>
    `ở đâu: ${s(p, 'target')} (mức nghiêm trọng: ${s(p, 'severity')})`,
  'scan.why': (p) => `vì sao: ${s(p, 'detail')}`,
  'scan.what-i-measured': (p) => `tôi đo được gì: ${s(p, 'detail')}`,
  'scan.but-only-this-far': (p) => `nhưng chỉ tới mức này thôi: ${s(p, 'boundary')}`,
  'scan.and-that-is-all': (p) => `và tôi chỉ nói được đến đây: ${s(p, 'boundary')}`,

  'scan.layer-b-boundary': (p) =>
    `nhưng chỉ tới mức này thôi: tôi xem ${s(p, 'considered')} cột có tên ` +
    `gợi ý rằng nó trỏ sang một bảng khác, và đối chiếu ${s(p, 'verified')} ` +
    `trong số đó với dữ liệu thật. Những cột không mang tên giống một tham ` +
    `chiếu thì tôi không xét tới.`,
  'scan.empty-columns.all': (p) =>
    `Cả ${s(p, 'checked')} cột đó đều không có dòng nào để đối chiếu — bảng ` +
    `chứa chúng đang rỗng. Tôi có chạy truy vấn cho từng cột và không nhận ` +
    `được gì, nên ở đây không học được điều gì cả. Một bảng rỗng không phải ` +
    `là một bảng sạch.`,
  'scan.empty-columns.some': (p) =>
    `${s(p, 'empty')} trong ${s(p, 'checked')} cột đó không có dòng nào để ` +
    `đối chiếu — bảng chứa chúng đang rỗng, nên tôi không học được gì về ` +
    `chúng. Một bảng rỗng không phải là một bảng sạch.`,
  'scan.sampling-floor': (p) =>
    `${s(p, 'columns')} cột trong số đó quá lớn để đọc hết, nên tôi lấy mẫu ` +
    `— mẫu nhỏ nhất là ${s(p, 'smallest')} dòng. Với cỡ mẫu ấy, những liên ` +
    `kết gãy hiếm hơn khoảng ${s(p, 'floor')}% của bảng có thể lọt hoàn toàn, ` +
    `nên việc tôi im lặng về chúng không đồng nghĩa với việc chúng sạch.`,
  'scan.partitions-covered': (p) =>
    `${s(p, 'count')} phân vùng được kiểm qua bảng cha của chúng, không phải ` +
    `bị bỏ qua`,

  'scan.ruled-out': (p) =>
    `đã kiểm và loại bỏ ${s(p, 'count')} chỗ (có chạy truy vấn, và dữ liệu ` +
    `thật không ủng hộ phỏng đoán ban đầu):`,
  'scan.did-not-check': (p) =>
    `không kiểm ${s(p, 'count')} chỗ (không học được gì về những chỗ này):`,
  'scan.silent-rules': () => 'những luật đã chạy mà không nêu gì, và chúng phủ tới đâu:',
  'scan.cost': (p) =>
    `database của bạn tốn: ${s(p, 'queries')} truy vấn · ${s(p, 'seconds')} giây · ` +
    `đọc ${s(p, 'rows')} dòng`,
  'scan.revoke': () => 'muốn thu hồi quyền truy cập này thì chạy:',

  'history.recorded': (p) =>
    `lịch sử: đã ghi lại thành lần quét số ${s(p, 'run')} trong ${s(p, 'file')}`,
  'history.not-recorded': (p) =>
    `lịch sử: lần quét này KHÔNG được ghi lại — ${s(p, 'problem')}\n` +
    `         báo cáo ở trên vẫn có giá trị; chỉ là lần quét sau sẽ không\n` +
    `         có gì để đối chiếu với nó`,
  'history.unfinished': (p) =>
    `lịch sử: lần quét số ${s(p, 'run')} trong ${s(p, 'file')} bị bỏ dở —\n` +
    `         ${s(p, 'problem')}\n` +
    `         báo cáo ở trên vẫn có giá trị; còn lần quét ấy sẽ được đọc là\n` +
    `         chưa hoàn tất, vì đúng là nó chưa hoàn tất`,
  // Lý do, nói ở dạng chung thay vì cho riêng một bước bump. Câu cũ viện lý do
  // của bước 1→2 ("định dạng cũ không có chỗ ghi một claim đến từ đâu") — đúng
  // với schema 1, và SAI ngay khi schema 4 lui schema 3, vì schema 3 có đủ cả
  // sáu trường xuất xứ.
  'history.moved': (p) =>
    `lịch sử: file đang nằm sẵn ở đường dẫn đó được ghi bằng lược đồ phiên\n` +
    `         bản ${s(p, 'version')}, mà bản dựng này không đọc được. Nó đã\n` +
    `         được DỜI đi, không bị xoá:\n` +
    `           ${s(p, 'to')}\n` +
    `         Không byte nào trong đó bị đổi — ${s(p, 'held')}. Không có\n` +
    `         đường nâng cấp: định dạng mới hỏi mỗi hàng những câu mà hàng cũ\n` +
    `         chưa bao giờ được hỏi, và cách duy nhất để chuyển chúng sang là\n` +
    `         bịa ra câu trả lời. Một cuốn lịch sử đầy câu trả lời bịa còn tệ\n` +
    `         hơn một cuốn bắt đầu lại từ đầu.`,
  'history.holds-runs': (p) => `nó giữ ${s(p, 'runs')} lần quét trước đó`,
  'history.holds-nothing': () => 'nó không giữ lần quét nào',
  'history.holds-uncounted': () => 'không đếm được bên trong nó có gì',
  'history.delete-freely': () =>
    'Bạn xoá nó lúc nào cũng được. Ở đây sẽ không có gì chạm vào nó nữa.',

  // ---- kết luận ----
  'verdict.nothing-seen': () =>
    'Không câu nào trong báo cáo này nói về dữ liệu của bạn, vì không có dữ ' +
    'liệu nào cả.',
  'verdict.nothing-seen.all-empty': (p) =>
    `Cả ${s(p, 'total')} bảng ở đây đều không có dòng nào. Tôi chỉ xem được ` +
    `phần cấu trúc.`,
  'verdict.nothing-seen.meaning': () =>
    'Một kết quả sạch trên một database rỗng nghĩa là chưa có gì được xem — ' +
    'không phải là mọi thứ đều ổn.',

  'verdict.silence-with-gaps': () =>
    'Tôi không nêu điều gì, và điều đó KHÔNG đồng nghĩa với việc không có gì sai.',
  'verdict.silence-with-gaps.meaning': () =>
    'Một bảng rỗng không phải là một bảng sạch. Nếu bạn vẫn nghĩ những bảng ' +
    'đó phải có dữ liệu, thì chính sự trống rỗng ấy mới là chỗ đáng hỏi lại — ' +
    'và đó cũng là thứ duy nhất ở đây mà tôi không giải nghĩa hộ bạn được.',

  'verdict.silence-is-clean': () =>
    'Tôi không nêu điều gì, và lần này phía sau sự im lặng đó không có khoảng trống nào.',
  'verdict.silence-is-clean.meaning': () =>
    'Mọi mục tiêu mà các luật này phủ tới đều có dữ liệu và đều đã được ' +
    'kiểm. Trong phạm vi ghi ở dòng ngay trên, đây là một kết quả thật, ' +
    'không phải một sự im lặng — điều mà những báo cáo cùng hình dạng khác ' +
    'không nói được.',

  'verdict.raised': (p) =>
    `Tôi nêu ${s(p, 'count')} chỗ. Chúng có phải là vấn đề hay không là ` +
    `quyết định của bạn, không phải của tôi.`,
  'verdict.raised.meaning': () =>
    'Một luật không nêu gì về những chỗ ấy là vì nó không nhìn được, chứ ' +
    'không phải vì nó đã nhìn và thấy ổn.',

  'verdict.gap.empty-tables': (p) =>
    `${s(p, 'empty')} trong ${s(p, 'total')} bảng không có dòng nào. Tôi có ` +
    `chạy truy vấn và không nhận được gì, nên ở đó tôi không học được điều ` +
    `gì — theo cả hai chiều.`,
  'verdict.gap.empty-tables.share': (p) =>
    `${s(p, 'empty')} trong ${s(p, 'total')} bảng — ${s(p, 'share')} số bảng ` +
    `ở đây — không có dòng nào. Tôi có chạy truy vấn và không nhận được gì, ` +
    `nên ở đó tôi không học được điều gì — theo cả hai chiều.`,
  'verdict.gap.empty-columns': (p) =>
    `${s(p, 'count')} cột mà một luật đọc dữ liệu đang nhắm tới lại không có ` +
    `dòng nào để đối chiếu. Những cột đó không sạch mà cũng không bẩn; tôi ` +
    `không đọc được chúng ở đúng câu hỏi quan trọng nhất.`,
  'verdict.gap.not-checked': (p) =>
    `${s(p, 'count')} mục tiêu mà một luật có quyền kiểm nhưng đã không ` +
    `kiểm. Chúng được nêu tên ở trên, kèm lý do từng cái.`,

  // ---- một con số lớn cỡ nào so với cái toàn thể của nó ----
  //
  // Đây là LƯỢNG, không phải câu. Chúng luôn được ghép vào một câu ở trên,
  // không bao giờ in một mình.
  'share.quarter': () => 'một phần tư',
  'share.third': () => 'một phần ba',
  'share.half': () => 'một nửa',
  'share.two-thirds': () => 'hai phần ba',
  'share.three-quarters': () => 'ba phần tư',
  'share.almost-all': () => 'gần như toàn bộ',
  'share.all': () => 'toàn bộ',

  // ---- thứ bước mô hình đã KHÔNG thêm vào ----
  //
  // Mỗi câu nêu PHẦN THÊM còn thiếu, và không câu nào chấm điểm báo cáo.
  // Những phát hiện ở trên do rule pack sinh ra và không hề đổi.
  'model.addition-heading': () => 'PHẦN NÀY DO MỘT MÔ HÌNH VIẾT, KHÔNG PHẢI DO MỘT LUẬT',
  'model.unavailable': () =>
    'Bình thường ở đây sẽ có thêm một đoạn tóm tắt bằng tiếng người, và lần ' +
    'này thì không: tôi không kết nối được tới mô hình mà bản dựng này dùng. ' +
    'Mọi thứ ở trên vẫn được làm ra mà không cần nó, đúng như mọi báo cáo ' +
    'trước khi có tính năng ấy.',
  // ---- câu trả lời có biên ----
  //
  // Do người viết, và đã được đo trên người. Model chỉ chọn cái nào áp dụng,
  // không viết câu.
  'answer.rests-on': (p) =>
    `Những gì lần quét nói được về chuyện đó dựa trên: ${s(p, 'facts')}.`,
  'answer.cannot': (p) =>
    `Lần quét này không trả lời được câu đó. Nó không xem tới ${s(p, 'missing')}, ` +
    `nên mọi câu tôi nói thêm ở đây đều là đoán.`,
  'answer.missing.who': () => 'những ai có liên quan',
  'answer.missing.when': () => 'chuyện xảy ra vào lúc nào',
  'answer.missing.why': () => 'vì sao chuyện đó xảy ra',
  'answer.missing.which_rows': () => 'cụ thể đó là những dòng nào',
  'answer.missing.impact': () => 'nó tốn gì hoặc ảnh hưởng tới đâu',
  'answer.missing.elsewhere': () => 'bất cứ thứ gì ngoài những bảng nó được trỏ vào',

  // Bản đọc lại. Ngôi thứ nhất, thì tương lai gần, và nêu ĐỦ tên định danh:
  // người dùng nhìn thấy một cái bảng mình không hề nhắc tới thì phải nhận ra
  // ngay lúc liếc qua, vì đó là lúc duy nhất họ còn nhìn.
  'rule.will-check.points-at-an-existing-row': (p) =>
    `Tôi sẽ kiểm rằng mọi giá trị ở ${s(p, 'columns')} của ${s(p, 'table')} ` +
    `đều khớp với một dòng trong ${s(p, 'target')}, và đếm những cái không khớp.`,
  'rule.will-check.is-never-missing': (p) =>
    `Tôi sẽ kiểm rằng không dòng nào trong ${s(p, 'table')} bỏ trống ` +
    `${s(p, 'columns')}, và đếm những dòng bỏ trống.`,
  'rule.will-check.is-never-repeated': (p) =>
    `Tôi sẽ kiểm rằng không hai dòng nào trong ${s(p, 'table')} trùng nhau ở ` +
    `${s(p, 'columns')}, và đếm những giá trị bị lặp.`,
  'rule.will-check.stays-within-its-usual-set': (p) =>
    `Tôi sẽ kiểm rằng ${s(p, 'columns')} của ${s(p, 'table')} không mang giá ` +
    `trị nào nằm ngoài tập nhỏ nó vẫn dùng, và đếm những giá trị nằm ngoài.`,
  'rule.cannot': (p) =>
    `Tôi không biến câu đó thành một phép kiểm chạy được ở đây. Nó ` +
    `${s(p, 'detail')}. Đó là giới hạn của những gì một lần quét database này ` +
    `phân xử được, không phải một phán xét về quy tắc bạn mô tả.`,
  'rule.unsupported.needs_a_number': () =>
    'dựa vào một con số mà tôi không có căn cứ nào để phán xét',
  'rule.unsupported.needs_time': () =>
    'nói về chuyện xảy ra lúc nào, còn tôi chỉ thấy database này ở một thời điểm',
  'rule.unsupported.needs_meaning': () =>
    'phụ thuộc vào ý nghĩa của giá trị đối với nghiệp vụ của bạn, không phải ' +
    'vào bản thân giá trị',
  'rule.unsupported.needs_another_system': () =>
    'nói về một thứ không nằm trong database này',
  'rule.unsupported.not_about_rows': () =>
    'nói về con người, quy trình hay quyền hạn chứ không phải về các dòng dữ liệu',
  'rule.unsupported.names_nothing_here': () =>
    'không nêu tên bảng hay cột nào tôi tìm thấy ở đây',

  'fact.column': () => 'cột nào',
  'fact.what-the-scan-says': () => 'điều lần quét đã nói về nó',
  'fact.confidence': () => 'mức chắc chắn của lần quét',
  'fact.how-measured': () => 'cách nó được đo',
  'fact.rows-examined': () => 'phát hiện này dựa trên bao nhiêu dòng',
  'fact.sampling': () => 'đếm hết mọi dòng hay chỉ lấy mẫu',
  'fact.targets-checked': () => 'luật này kiểm bao nhiêu mục tiêu',
  'fact.boundary': () => 'điều lần quét nói là nó không kết luận được',

  'model.declined': () =>
    'Bình thường ở đây sẽ có thêm một đoạn tóm tắt bằng tiếng người, và lần ' +
    'này thì không: gửi đi đồng nghĩa với việc cho một bên thứ ba thấy một ' +
    'phần dữ liệu của bạn, và bản dựng này không làm vậy. Mọi thứ ở trên vẫn ' +
    'được làm ra mà không cần nó.',

  // ---- dòng ghi phạm vi ----
  'strip.tables-visible': (p) =>
    `nhìn được ${s(p, 'visible')} trong ${s(p, 'total')} bảng`,
  'strip.tables-visible-no-total': (p) =>
    `nhìn được ${s(p, 'visible')} bảng, không rõ tổng cộng có bao nhiêu`,
  'strip.targets-eligible': (p) => `${s(p, 'count')} mục tiêu thuộc diện xét`,
  'strip.targets-eligible-unknown': (p) =>
    `không rõ có bao nhiêu mục tiêu thuộc diện xét (${s(p, 'rules')} luật ` +
    `không nói được)`,
  'strip.targets-checked': (p) => `đã kiểm ${s(p, 'count')} mục tiêu`,
  'strip.targets-not-checked': (p) => `chưa kiểm ${s(p, 'count')}`,
  'strip.rules-did-not-run': (p) => `${s(p, 'count')} luật không chạy`,
  'strip.rule.did-not-run': (p) => `${s(p, 'rule')} — không chạy`,
  'strip.rule.no-denominator': (p) =>
    `${s(p, 'rule')} — có chạy, không nêu gì, và không nói được là trên tổng bao nhiêu`,
  'strip.rule.none-exist': (p) =>
    `${s(p, 'rule')} — ở đây không có thứ nào thuộc loại này để kiểm`,
  'strip.rule.raised-nothing': (p) =>
    `${s(p, 'rule')} — không nêu gì, sau khi đã kiểm ${s(p, 'checked')} ` +
    `trong ${s(p, 'eligible')}${s(p, 'hole')}`,
  'strip.rule.not-reached': (p) => `, ${s(p, 'count')} chỗ chưa với tới`,

  // ---- câu nói tôi đọc được bao nhiêu ----
  'coverage.no-total': (p) =>
    `Tôi đọc được ${s(p, 'visible')} bảng ở đây. Còn tổng cộng có bao nhiêu ` +
    `bảng thì tôi không biết — không có gì cho tôi biết cả, và tôi sẽ không ` +
    `mặc định hai con số ấy bằng nhau.`,
  'coverage.all': (p) =>
    `Tôi đọc được ${s(p, 'visible')} trong ${s(p, 'total')} bảng — tức là tất cả.`,
  'coverage.partial': (p) =>
    `Tôi đọc được ${s(p, 'visible')} trong ${s(p, 'total')} bảng. Còn ` +
    `${s(p, 'unexamined')} bảng nữa tồn tại trong database này mà tôi không ` +
    `xem tới; không câu nào dưới đây nói về chúng.`,

  // ---- connector với tới được đâu ----
  'scope.nothing-asked': (p) =>
    `Không schema nào được chỉ định, nên ở đây tôi không đọc gì cả. Database ` +
    `này có ${s(p, 'tables')} bảng${s(p, 'readable')}, và không bảng nào ` +
    `được xem tới`,
  'scope.granted-when-unknown': () =>
    'Tôi không biết quyền truy cập này được cấp từ lúc nào — Postgres không ghi lại điều đó',
  'scope.tables-in': (p) =>
    `${s(p, 'readable')} trong ${s(p, 'total')} bảng thuộc ${s(p, 'schemas')}`,
  'scope.refused': (p) =>
    `${s(p, 'schemas')} — có được chỉ định, và tài khoản này không có quyền ` +
    `vào. Ở đó tôi không đọc gì cả, và điều đó khác với việc ở đó không có gì`,
  'scope.missing': (p) =>
    `${s(p, 'schemas')} — có được chỉ định, và database này không có schema nào tên vậy`,
  'scope.not-looked-at': (p) =>
    `Hoàn toàn không xem tới: ${s(p, 'schemas')}${s(p, 'more')}`,
  'scope.unreadable-tables': (p) =>
    `Có ${s(p, 'count')} bảng ở đây mà tài khoản này không đọc được — không ` +
    `câu nào bên dưới nói về chúng`,
  'scope.unreadable-columns': (p) =>
    `${s(p, 'count')} cột bị che khỏi tài khoản này, nằm trong những bảng mà ` +
    `nó vẫn đọc được phần còn lại`,
  'scope.outside': (p) =>
    `Còn ${s(p, 'count')} bảng nữa trong database này, nằm ngoài ` +
    `${s(p, 'schemas')}. Không câu nào bên dưới nói về chúng`,
  'scope.outside-within-reach': (p) =>
    `  trong số đó, ${s(p, 'count')} bảng tài khoản này ĐỌC ĐƯỢC — không phải ` +
    `ngoài tầm với, chỉ là không nằm trong schema tôi được chỉ tới`,

  // ---- Tầng A ----
  'layer-a.fk.plain': (p) =>
    `${s(p, 'rows')} dòng trong ${s(p, 'table')} đang trỏ tới một bản ghi ` +
    `${s(p, 'parent')} không còn tồn tại. Phần đó thì chắc chắn — tôi đếm ` +
    `được. Còn nó có đáng ngại hay không thì không chắc: có hệ thống cố ý ` +
    `giữ lại tham chiếu tới bản ghi đã xoá. Nếu hệ thống của bạn không phải ` +
    `vậy, thì bất cứ thứ gì đi theo liên kết đó — một màn hình, một báo cáo, ` +
    `một bản xuất — sẽ không có gì để hiển thị cho những dòng ấy.`,
  'layer-a.fk.technical': (p) =>
    `Khoá ngoại ${s(p, 'name')} trên ${s(p, 'table')} (${s(p, 'columns')}) → ` +
    `${s(p, 'parent')} đang ở trạng thái NOT VALID, nên Postgres chưa bao giờ ` +
    `kiểm những dòng có sẵn từ trước. ${s(p, 'rows')} dòng trong số đó không ` +
    `có bản ghi cha tương ứng.`,
  'layer-a.check.plain': (p) =>
    `${s(p, 'rows')} dòng trong ${s(p, 'table')} không thoả một quy tắc mà ` +
    `database được yêu cầu giữ. Dòng mới thì buộc phải theo; những dòng này ` +
    `đã nằm sẵn ở đó từ trước khi quy tắc được thêm vào, và không ai quay ` +
    `lại kiểm chúng. Những dòng đó sai, hay quy tắc đến muộn — cái đó bạn nói.`,
  'layer-a.check.technical': (p) =>
    `Ràng buộc ${s(p, 'name')} trên ${s(p, 'table')} đang ở trạng thái NOT ` +
    `VALID. ${s(p, 'rows')} dòng có sẵn không thoả ${s(p, 'definition')}.`,
  'layer-a.index.unique.plain': (p) =>
    `${s(p, 'table')} có một quy tắc chống trùng đang bị TẮT. Ngay lúc này ` +
    `vẫn tạo được bản ghi trùng, và không gì chặn lại cả.`,
  'layer-a.index.plain': (p) =>
    `Một index trên ${s(p, 'table')} bị dựng dở dang. Những câu truy vấn dựa ` +
    `vào nó đang phải đọc theo cách chậm.`,
  'layer-a.index.technical': (p) =>
    `Index ${s(p, 'name')} trên ${s(p, 'table')} có ` +
    `indisvalid=${s(p, 'valid')}, indisready=${s(p, 'ready')}. Đây đúng là ` +
    `thứ mà một lệnh CREATE INDEX CONCURRENTLY thất bại để lại` +
    (Number(p['unique'] ?? 0) === 1
      ? ', và ràng buộc duy-nhất đang không được thi hành.'
      : '.'),
  'layer-a.constraint.none-eligible': () =>
    'Ở đây không có gì bị bỏ dở nửa chừng: database này không có ràng buộc ' +
    'nào mà Postgres được yêu cầu giữ nhưng chưa bao giờ kiểm, nên luật này ' +
    'không có gì để xem.',
  'layer-a.constraint.none-checked': (p) =>
    `Tôi không kiểm được cái nào trong ${s(p, 'eligible')} ràng buộc thuộc ` +
    `phạm vi, nên tôi không có gì để báo về chúng. Điều đó không đồng nghĩa ` +
    `với việc không có gì sai.`,
  'layer-a.constraint.one-kept': () =>
    'Ràng buộc duy nhất mà tôi kiểm được đang được giữ đúng — không dòng nào ' +
    'trong đó phá quy tắc nó được giao.',
  'layer-a.constraint.all-kept': (p) =>
    `Cả ${s(p, 'checked')} ràng buộc mà tôi kiểm được đều đang được giữ đúng ` +
    `— không dòng nào trong bất kỳ ràng buộc nào phá quy tắc nó được giao.`,
  'layer-a.constraint.technical': (p) =>
    `Không ràng buộc chưa-được-xác-thực nào có dòng vi phạm, trên ` +
    `${s(p, 'checked')} trong ${s(p, 'eligible')} ràng buộc thuộc diện xét. ` +
    `Index là một luật riêng, có mẫu số riêng.`,
  'layer-a.index.none-visible': (p) =>
    `Tài khoản này không nhìn thấy index nào trong ${s(p, 'where')}, nên ` +
    `luật này không có gì để xem.`,
  'layer-a.index.one-on': () =>
    'Index duy nhất tôi nhìn thấy đang bật. Nếu nó được dựng để chặn trùng ' +
    'lặp, thì nó đang chặn.',
  'layer-a.index.all-on': (p) =>
    `Cả ${s(p, 'eligible')} index tôi nhìn thấy đều đang bật. Không có cái ` +
    `nào được dựng để chặn trùng lặp mà lại nằm đó không chặn gì.`,

  'layer-a.index.technical-negative': (p) =>
    `${s(p, 'eligible')} index trong ${s(p, 'where')} báo indisvalid và ` +
    `indisready đều đúng. Đọc từ pg_index; không truy vấn dữ liệu nào, nên ` +
    `không có gì bị bỏ qua vì ngân sách.`,

  'layer-a.bound.constraints-checked': (p) =>
    `Đã kiểm ${s(p, 'checked')} trong ${s(p, 'eligible')} ràng buộc mà ` +
    `Postgres chưa xác thực, trong ${s(p, 'where')}, trên ${s(p, 'tables')} ` +
    `bảng đọc được.`,
  'layer-a.bound.by-ceiling': (p) =>
    `${s(p, 'count')} cái hoàn toàn không được chạy — lần quét đã chạm trần ` +
    `chi phí trên database này.`,
  'layer-a.bound.unreadable': (p) =>
    `${s(p, 'count')} cái không đọc được: câu truy vấn thất bại. Những cái đó ` +
    `KHÔNG phải đã sạch, mà là chưa nhìn thấy — và một bảng tôi không nhìn ` +
    `vào trong được mới chính là bảng đáng hỏi lại.`,
  'layer-a.bound.already-validated': () =>
    'Những ràng buộc mà Postgres đã xác thực rồi thì không thể bị vi phạm, ' +
    'nên tôi không kiểm lại. Ở đây không có câu nào nói về những quy tắc chưa ' +
    'bao giờ được khai báo — đó là câu hỏi khác, và khó hơn. Index được đếm ' +
    'riêng.',
  'layer-a.bound.no-indexes': (p) =>
    `Tài khoản này không nhìn thấy index nào trong ${s(p, 'where')}, nên ` +
    `không cái nào được kiểm.`,
  'layer-a.bound.one-index': (p) =>
    `Đã kiểm index duy nhất mà tài khoản này nhìn thấy trong ${s(p, 'where')}.`,
  'layer-a.bound.all-indexes': (p) =>
    `Đã kiểm cả ${s(p, 'eligible')} index mà tài khoản này nhìn thấy trong ` +
    `${s(p, 'where')}.`,
  'layer-a.bound.index-tail': () =>
    ' Những index nằm trên bảng nó không đọc được thì không nằm trong con số ' +
    'ấy. Và một index đang bật chưa chắc đã là index ĐÚNG — những cái ở đây ' +
    'có phải thứ bạn cần hay không là câu hỏi khác, và không phải câu luật ' +
    'này hỏi.',

  // ---- Tầng B ----
  'layer-b.counted': (p) =>
    `${s(p, 'residual')} trong ${s(p, 'present')} dòng của ${s(p, 'table')} ` +
    `mang một ${s(p, 'column')} không khớp với bản ghi ${s(p, 'parent')} nào. `,
  'layer-b.sampled': (p) =>
    `Tôi xem ${s(p, 'present')} dòng lấy rải ra khắp ${s(p, 'table')} — ` +
    `không phải cả bảng — và ${s(p, 'residual')} dòng trong số đó mang một ` +
    `${s(p, 'column')} không khớp với bản ghi ${s(p, 'parent')} nào, tức ` +
    `${s(p, 'pct')}% của phần tôi đã xem. Tôi không đếm phần còn lại của ` +
    `bảng, nên tôi không nói được tổng cộng có bao nhiêu. `,
  'layer-b.set-aside': (p) =>
    `Trước hết, xin gạt ra: có thêm ${s(p, 'count')} dòng nữa cùng mang đúng ` +
    `MỘT giá trị. Một giá trị lặp lại nhiều đến thế trông giống thứ mà schema ` +
    `này dùng để nói "không có" hoặc "tất cả", nên tôi không tính chúng là ` +
    `không khớp. `,
  'layer-b.tail-one': (p) =>
    `${s(p, 'rate')}% còn lại thì khớp, nên cột này trông đúng là đang trỏ ` +
    `sang ${s(p, 'parent')}. Không có gì trong database bắt buộc điều đó, nên ` +
    `tôi không nói được dòng ấy là thứ sót lại mà bạn sẽ muốn biết, hay là ` +
    `một dòng được giữ có chủ ý.`,
  'layer-b.tail-many': (p) =>
    `${s(p, 'rate')}% còn lại thì khớp, nên cột này trông đúng là đang trỏ ` +
    `sang ${s(p, 'parent')}. Không có gì trong database bắt buộc điều đó, nên ` +
    `tôi không nói được ${s(p, 'residual')} dòng ấy là thứ sót lại mà bạn sẽ ` +
    `muốn biết, hay là những dòng được giữ có chủ ý.`,
  'layer-b.technical': (p) =>
    `${s(p, 'column')} (${s(p, 'distinct')} giá trị khác nhau trên ` +
    `${s(p, 'present')} dòng không rỗng ${s(p, 'how')}) khớp với ` +
    `${s(p, 'parentColumn')} ở mức ${s(p, 'rate')}%, còn ${s(p, 'residual')} ` +
    `dòng không khớp (${s(p, 'pct')}%)${s(p, 'aside')}. Không có khoá ngoại ` +
    `nào được khai báo giữa hai bên.`,
  'layer-b.how.counted': () => '— đếm từng dòng một, không sót',
  'layer-b.how.sampled': (p) =>
    `lấy mẫu bằng TABLESAMPLE SYSTEM (${s(p, 'pct')}%) REPEATABLE ` +
    `(${s(p, 'seed')}) trên ước lượng ${s(p, 'estimated')} dòng`,
  'layer-b.aside.budget-ceiling': () =>
    'lần quét đã chạm trần chi phí trên database này',
  // Giữ nguyên văn câu lỗi của driver bên trong một câu của SẢN PHẨM. Không
  // dịch phần lỗi: đó là Postgres đang nói, và người ta có thể cần tìm đúng
  // chuỗi ấy trên mạng.
  'layer-b.aside.query-failed': (p) => `câu truy vấn thất bại: ${s(p, 'detail')}`,
  'layer-b.aside.empty-draw': (p) =>
    `catalog ước lượng ${s(p, 'estimated')} dòng, nên tôi rút ` +
    `${s(p, 'pct')}% của bảng — và phần rút ra không có gì trong đó. Hoặc ước ` +
    `lượng cao hơn thực tế rất nhiều, hoặc mẫu rút không may; ở đây không có ` +
    `gì nói được là cái nào, nên tôi không học được gì về cột này`,
  'layer-b.aside.one-repeated-value': (p) =>
    `cả ${s(p, 'orphans')} giá trị không khớp với bản ghi ${s(p, 'parent')} ` +
    `nào đều là cùng MỘT giá trị, lặp đi lặp lại. Một giá trị lặp nhiều đến ` +
    `thế đọc ra như thứ schema này dùng để nói "không có" hoặc "tất cả", chứ ` +
    `không phải chừng ấy liên kết dẫn tới hư không — nên tôi không nêu nó ` +
    `thành một câu hỏi`,
  'layer-b.aside.match-rate-too-low': (p) =>
    `chỉ ${s(p, 'rate')}% giá trị khớp được với ${s(p, 'parent')} — tên trùng ` +
    `nhau ở đây nhiều khả năng là ngẫu nhiên, không phải một tham chiếu`,
  'layer-b.question': (p) =>
    `Trong ${s(p, 'table')}, ${s(p, 'column')} có buộc phải luôn trỏ tới một ` +
    `bản ghi còn tồn tại không?\n` +
    `  • Có — vậy những dòng tôi tìm ra là thứ sót lại, và đáng dọn.\n` +
    `  • Không, đó là chủ ý — vậy đây không phải vấn đề, và tôi sẽ thôi nêu nó.\n` +
    `  • Tôi không biết — vậy thì nên hỏi lại người đã dựng ra cái này.`,
};
