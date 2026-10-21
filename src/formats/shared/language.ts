/**
 * ISO 639-1 two-letter codes followed by their ISO 639-2/T three-letter codes, in pairs of five
 * characters.
 */
const ISO_639_1 =
    'aaaar ababk aeave afafr akaka amamh anarg arara asasm avava ayaym azaze babak bebel bgbul ' +
    'bibis bmbam bnben bobod brbre bsbos cacat ceche chcha cocos crcre csces cuchu cvchv cycym ' +
    'dadan dedeu dvdiv dzdzo eeewe elell eneng eoepo esspa etest eueus fafas ffful fifin fjfij ' +
    'fofao frfra fyfry gagle gdgla glglg gngrn guguj gvglv hahau heheb hihin hohmo hrhrv hthat ' +
    'huhun hyhye hzher iaina idind ieile igibo iiiii ikipk ioido isisl itita iuiku jajpn jvjav ' +
    'kakat kgkon kikik kjkua kkkaz klkal kmkhm knkan kokor krkau kskas kukur kvkom kwcor kykir ' +
    'lalat lbltz lglug lilim lnlin lolao ltlit lulub lvlav mgmlg mhmah mimri mkmkd mlmal mnmon ' +
    'mrmar msmsa mtmlt mymya nanau nbnob ndnde nenep ngndo nlnld nnnno nonor nrnbl nvnav nynya ' +
    'ococi ojoji omorm orori ososs papan pipli plpol pspus ptpor quque rmroh rnrun roron rurus ' +
    'rwkin sasan scsrd sdsnd sesme sgsag sisin skslk slslv smsmo snsna sosom sqsqi srsrp ssssw ' +
    'stsot susun svswe swswa tatam tetel tgtgk ththa titir tktuk tltgl tntsn toton trtur tstso ' +
    'tttat twtwi tytah uguig ukukr ururd uzuzb veven vivie vovol wawln wowol xhxho yiyid yoyor ' +
    'zazha zhzho zuzul';

let table: Map<string, string> | undefined;

/**
 * The ISO 639-2 code of a language tag for containers that store only three letters (MP4 mdhd, the
 * Matroska Language element): a three-letter primary subtag as written, a two-letter one through
 * ISO 639-1; undefined otherwise.
 */
export function iso639Language(tag: string | undefined): string | undefined {
    const primary = tag?.split('-')[0]?.toLowerCase();
    if (!primary || !/^[a-z]{2,3}$/.test(primary)) return undefined;
    if (primary.length === 3) return primary;
    table ??= new Map(ISO_639_1.split(' ').map(pair => [pair.slice(0, 2), pair.slice(2)]));
    return table.get(primary);
}
